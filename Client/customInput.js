import * as THREE from 'three';

const rad90 = Math.PI/2;
const keyStates = {};
let mousex = 0;
let mousey = 0;
let camX = 0;
//let camY = 0;
let camYDelta = 0;
let camXDelta = 0;

let mcount = false;
let prevmcount = false;

let sensitivity = 1.5;

document.addEventListener( 'keydown', ( event ) => {
    keyStates[ event.code ] = true;
} );
document.addEventListener( 'keyup', ( event ) => {
    keyStates[ event.code ] = false;
} );
//let mouseTime = 0;
space3d.addEventListener( 'mousedown', () => {
    document.body.requestPointerLock();
    //mouseTime = performance.now();//seems to be for tracking mouse down time, but not needed for now.
} );
space3d.addEventListener( 'mouseup', () => {
    document.body.requestPointerLock();
    //removed shoot ball. but might require input for other features
} );
document.body.addEventListener( 'mousemove', ( event ) => {
    if ( document.pointerLockElement === document.body ) {
        mousex = -event.movementX;
        mousey = -event.movementY;
        mcount = !mcount;
    }
} );
function playerControls(actor, deltaTime){
    if(mcount != prevmcount){//detects if mouse has truly been moved
        camYDelta = mousex * deltaTime * sensitivity;
        camXDelta = mousey * deltaTime * sensitivity;
    }else{
        camYDelta = 0;
        camXDelta = 0;
    }
    prevmcount = mcount;
    /*
    camY += camXDelta;
    if(camY > Math.PI){
        camY -= Math.PI;
    } else if(camY < -Math.PI){
        camY += Math.PI;
    }
    */
    camX = THREE.MathUtils.clamp(camX + camXDelta, -rad90, rad90);
    let forward = keyStates[ 'KeyW' ];
    let backward = keyStates[ 'KeyS' ];
    let left = keyStates[ 'KeyA' ];
    let right = keyStates[ 'KeyD' ];
    actor.moving = (forward || backward || right || left);
    actor.inputDir.set( left?-1:right?1:0, 0, forward?-1:backward?1:0 ).transformDirection(actor.groundColliderMesh.matrixWorld);
    //actor.forwardDir.set(1,0,0).applyAxisAngle(upVector, camYDelta).transformDirection(actor.groundColliderMesh.matrixWorld);
    actor.forwardDir.set(1,0,0).transformDirection(actor.groundColliderMesh.matrixWorld).applyAxisAngle(actor.targetup, camYDelta);
}
export { keyStates, playerControls, camX };