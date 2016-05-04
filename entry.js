const Rx = require('rx')
const THREE = require('three')
const OrbitControls = require('three-orbit-controls')(THREE)
const data = require('json!./geolig.json')

const earthRadius = 0.5

// From geolig.json
const features$ = new Rx.Observable.just(data.data)

// Stress slider. Value is between 0 and 1.
const slider = document.getElementById('slider')
// Update stress on input.
const stress$ = Rx.Observable
  .fromEvent(slider, 'input', (e) => e.target.value * 5)
  .startWith(slider.value * 5)

// Get canvas dimensions from canvas-wrapper.
const canvasWrapper = document.getElementById('canvas-wrapper')
const dimensions$ = new Rx.ReplaySubject(1)
const updateDimensions = () =>
  dimensions$.onNext({
    width: canvasWrapper.clientWidth,
    height: canvasWrapper.clientHeight
  })
window.addEventListener('load', updateDimensions)
window.addEventListener('resize', updateDimensions)

// Renderer
const canvas = document.getElementById('canvas')
// Keep renderer dimensions up to date.
const renderer$ = dimensions$.scan((renderer, d) => {
  renderer.setSize(d.width, d.height)
  return renderer
}, new THREE.WebGLRenderer({canvas: canvas}))

// Camera
// Create observable manually so we can trigger updates based on
// dimensions and camera controls.
const camera$ = Rx.Observable.create(observer => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.x = 0
  camera.position.y = 0.5
  camera.position.z = -1

  const cameraControls = new OrbitControls(camera, canvas)
  cameraControls.target.set(0, 0, 0)

  const onNext = observer.onNext.bind(observer, camera)

  // Update when dimensions change.
  dimensions$.subscribe(d => {
    camera.aspect = d.width/d.height
    camera.updateProjectionMatrix()
    onNext()
  })

  // Update when camera controls are used.
  cameraControls.addEventListener('change', onNext)

  onNext()
})

// Create observable THREE object that updates observable children.
function objectWithChildren(object, children) {
  // Make sure all children are observables.
  children = children.map(c =>
    typeof c.subscribe === 'function' ?
      c :
      Rx.Observable.just(c)
  )
  return Rx.Observable
    .combineLatest(children)
    .scan((o, c) => {
      o.remove.apply(o, o.children)
      o.add.apply(o, c)
      return o
    }, object)
}

// Location in sky is adjusted according to time.
const time$ = new Rx.BehaviorSubject(Date.now())
const sun$ = time$.scan((sun, t) => {
  const d = new Date(t)
  // +6 is to adjust it to correct place in sky
  const rad = (d.getUTCHours() + 6 + d.getMinutes() / 60) / 24 * 2 * Math.PI
  sun.position.set(10 * Math.sin(rad), 0, 10 * Math.cos(rad))
  return sun
}, Object.assign(new THREE.SpotLight(0xffffff, 0.8), {decay: 0}))

// Load texture as observable.
function loadTexture$(url) {
  return Rx.Observable.create((observer) => {
    new THREE.TextureLoader().load(url,
      img => { observer.onNext(img); observer.onCompleted() },
      () => {},
      xhr => { observer.onError(xhr) }
    )
  })
}

const earth$ = Rx.Observable
  .combineLatest([
    'images/earthmap1k.jpg',
    'images/earthbump1k.jpg',
    'images/earthspec1k.jpg'
  ].map(loadTexture$))
  .map(textures => {
    // Set texture filters to avoid console warning.
    textures.forEach(t => t.minFilter = THREE.NearestFilter)

    const geometry = new THREE.SphereGeometry(earthRadius, 32, 32)
    // Rotate 180 to match lat lon calcs later
    geometry.rotateY(Math.PI)

    const material = new THREE.MeshPhongMaterial({
      map: textures[0],
      bumpMap: textures[1],
      bumpScale: 0.05,
      specularMap: textures[2],
      specular: new THREE.Color('grey'),
      shininess: 10
    })

    return new THREE.Mesh(geometry, material)
})

const featureGroup$ = features$.flatMapLatest(features => {
  const group = new THREE.Group()
  group.add.apply(group, features.map(createFeature))

  // Update opacity on stress slider changes.
  return stress$.scan((group, stress) => {
    features.forEach((feature, i) => {
      // If stress is min or max, show all features.
      group.children[i].material.opacity = stress === 0 || stress === 5 ?
        1 :
        Math.min(1, Math.max(0.1, 1 - Math.pow(feature.avgStressIntensity - stress, 2)))
    })
    return group
  }, group)
})

// Create mesh from feature.
function createFeature(feature) {
  const height = Math.max(Math.log2(feature.totalCallTimeInSeconds / 10) / 200, 0.01)
  // radiusTop, radiusBottom, height, radiusSegments
  const geometry = new THREE.CylinderGeometry(0.001, 0.001, height, 16)
  // Make point the center.
  geometry.translate(0, height / 2, 0)
  // Rotate so lookAt points as expected.
  geometry.rotateX( -Math.PI / 2 )
  const material = new THREE.MeshBasicMaterial({
    color: "hsl(" + (100 - (feature.avgStressIntensity * 20)) + ", 100%, 50%)"
  })
  material.transparent = true
  material.opacity = 1
  const mesh = new THREE.Mesh(
    geometry,
    material
  )
  // Convert lat/lon to xyz.
  const lat = feature.coordinates[1] * Math.PI / 180
  const lon = feature.coordinates[0] * Math.PI / 180
  mesh.position.set(
    -earthRadius * Math.cos(lat) * Math.cos(lon),
    earthRadius * Math.sin(lat),
    earthRadius * Math.cos(lat) * Math.sin(lon)
  )
  // Point back at center.
  mesh.lookAt(new THREE.Vector3(0, 0, 0))

  return mesh
}

const scene$ = objectWithChildren(new THREE.Scene(), [
  new THREE.AmbientLight(0xffffff, 0.6),
  sun$,
  earth$,
  featureGroup$
])

// Render on change.
Rx.Observable
  .combineLatest(renderer$, scene$, camera$)
  .subscribe(([renderer, scene, camera]) => {
    renderer.render(scene, camera)
  })
