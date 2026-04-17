//original custom gameplay camera, file for reference.

let maxCamDist = 3;
const camraycaster = new THREE.Raycaster();
camraycaster.firstHitOnly = true;
camraycaster.far = maxCamDist;

const camera = new THREE.PerspectiveCamera(80, window.innerWidth/window.innerHeight, 0.1, 3000);
camera.position.set(0.5, 1, 1.5);
camera.rotation.order = 'YXZ';
camera.rotation.set(0, 0.1 * Math.PI ,0);

const camboom = new THREE.Group();
camboom.rotation.set(0,0,0);
const camvert = new THREE.Group();
camboom.add(camvert);
camvert.rotation.set(0,0,0);

function SetupCamera(actor){ 
    camvert.position.set(0,actor.useHeight,0);
    camera.rotation.set(0,0,0);
    camera.position.set(0,0, 2); 
}
function updateCamera(actor, deltaTime){
    camboom.position.copy(actor.groundColliderMesh.position);
    camboom.up.lerp(actor.targetup, deltaTime * 2);
    miscvect.copy(actor.forwardDir).cross(camboom.up).add(actor.groundColliderMesh.position);
    camboom.lookAt(miscvect);
    camvert.rotation.x = camX;
    miscvect.copy(camboom.up).setLength(actor.useHeight);
    camraycaster.ray.origin.copy(actor.groundColliderMesh.position).add(miscvect);
    camera.getWorldDirection(miscvect); camraycaster.ray.direction.copy(miscvect.negate());
    const camhit = camraycaster.intersectObject( world.layers[CollisionTags.Environment].collider )[ 0 ];
    let camdist = camhit?camhit.distance:maxCamDist;
    camera.position.z = camdist;
}