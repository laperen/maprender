import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import {OutlineEffect} from 'three/addons/effects/OutlineEffect.js';
import { upVector, miscvect, clock, slopelimit, CheckVector3Equals, rad90 } from 'scripts/utilproperties.js';
import { CollisionTags, level } from 'scripts/GameObjects.js';
import { world, WorldCollision, teleportPlayerIfOob, GetFlatestTriPoint } from 'scripts/collision.js';
import { PreloadScene, arrowHelper, clearcol, camboom, camvert, SetupCamera, outlineList } from 'scripts/loading.js';
import { keyStates, playerControls, camX } from 'scripts/playerInput.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { reportystate, inertiaback, inertiabar, OnScreenDebug } from 'scripts/gui.js';
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const STEPS_PER_FRAME = 5;

const camera = new THREE.PerspectiveCamera(80, window.innerWidth/window.innerHeight, 0.1, 3000);
camera.position.set(0.5, 1, 1.5);
camera.rotation.order = 'YXZ';
camera.rotation.set(0, 0.1 * Math.PI ,0);

let maxCamDist = 3;
const camraycaster = new THREE.Raycaster();
camraycaster.firstHitOnly = true;
camraycaster.far = maxCamDist;

const charraycaster = new THREE.Raycaster();
charraycaster.firstHitOnly = true;

let surfacehit;
let useplayer;
const tempUp = new THREE.Vector3();
const prevpos = new THREE.Vector3();

function updateCamera(actor, deltaTime){
    camboom.position.copy(actor.groundColliderMesh.position);
    camboom.up.lerp(actor.targetup, deltaTime * 2);
    miscvect.copy(actor.forwardDir).cross(camboom.up).add(actor.groundColliderMesh.position);
    camboom.lookAt(miscvect);
    
    camvert.rotation.x = camX;
    miscvect.copy(camboom.up).setLength(actor.useHeight);
    camraycaster.ray.origin.copy(actor.groundColliderMesh.position).add(miscvect);
    camera.getWorldDirection(miscvect);
    camraycaster.ray.direction.copy(miscvect.negate());
    const camhit = camraycaster.intersectObject( world.layers[CollisionTags.Environment].collider )[ 0 ];
    let camdist = camhit?camhit.distance:maxCamDist;
    camera.position.z = camdist;
}
function checkOnSurface(actor, normal){
    charraycaster.ray.origin.copy(actor.groundColliderMesh.position);
    miscvect.copy(normal);
    charraycaster.ray.direction.copy(miscvect.negate());
    return charraycaster.intersectObject(world.layers[CollisionTags.Environment].collider)[0];
}
const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(clearcol);
renderer.setPixelRatio(window.devicePixelRatio);
space3d.appendChild(renderer.domElement);
let outlineEffect = new OutlineEffect(renderer);

function GroundMovement(actor, deltaTime, reverseDamping){
    let speedDelta = deltaTime * actor.maxSpeed;
    if(actor.moving){
        miscvect.copy(actor.inputDir).setLength(speedDelta);
        actor.accelAccum.add(miscvect);
        actor.accelAccum.x *= reverseDamping;
        actor.accelAccum.z *= reverseDamping;
    }else{
        miscvect.copy(actor.accelAccum).setLength(speedDelta * 0.5);
        actor.accelAccum.sub(miscvect);
    }
    actor.accelAccum.y *= reverseDamping;
    if(actor.jump){
        let wallpercent = actor.wallrideangle/rad90;

        actor.accelAccum.multiplyScalar(actor.airMovePercentage);
        actor.accelAccum.reflect(actor.targetup);
        miscvect.copy(actor.targetup).setLength(actor.jumpForce * wallpercent);
        actor.accelAccum.add(miscvect);

        ArrowHelper(actor, actor.targetup);
        actor.gravityAccum = actor.jumpForce * (1-wallpercent) + actor.accelAccum.y;
        actor.accelAccum.y = 0;

        if(actor.wallriding){
            actor.forwardDir.applyAxisAngle(upVector, Math.PI);
        }
        actor.targetup.copy(upVector);
        actor.inertiamax = 0;
    }
}
function AirMovement(actor, deltaTime, reverseDamping){
    if(actor.moving){
        miscvect.copy(actor.inputDir).setLength(actor.airNudge * deltaTime);
        actor.airNudgeAccum.add(miscvect);
        actor.airNudgeAccum.multiplyScalar(reverseDamping);
    }
    if(actor.jump){
        //mid air jump
        actor.targetup.copy(upVector);
    }
}
function ApplyControls(actor, deltaTime){
    let jumpinput = keyStates[ 'Space' ];
    if(jumpinput){
        actor.jump = jumpinput && jumpinput != actor.prevJump;
    }
    actor.prevJump = jumpinput;
    let reverseDamping = Math.exp( - 4 * deltaTime );
    if(surfacehit){
		reportystate.innerText = "on Surface";
        GroundMovement(actor, deltaTime, reverseDamping);
    }else{
		reportystate.innerText = "Air";
        AirMovement(actor, deltaTime, reverseDamping);
    }
}
const closeToZero = 0.001 * 0.001;
const zerovect = new THREE.Vector3(0,0,0);
function GetCloseToZero(vect){
    let magnitude = vect.lengthSq();
    return magnitude <= closeToZero?zerovect:vect;
}
function ApplyVelocity(actor){
    //composite velocity
    actor.velocity.copy(GetCloseToZero(actor.accelAccum));
    actor.velocity.y += actor.gravityAccum;
    actor.velocity.add(GetCloseToZero(actor.airNudgeAccum));
}
function SurfaceDetection(actor, deltaTime, isplayer){
    miscvect.copy(actor.velocity).multiplyScalar( deltaTime );
    prevpos.copy(actor.groundColliderMesh.position);
    actor.groundColliderMesh.position.add( miscvect );
    let worldCollisionResult = WorldCollision(actor, CollisionTags.Environment, miscvect);//each collision check will be done this way
    actor.groundColliderMesh.position.add( worldCollisionResult.delta );
    tempUp.copy(actor.targetup);
    let truespeed = prevpos.sub(actor.groundColliderMesh.position).lengthSq()/(deltaTime * deltaTime);
    //set gravity
    if(worldCollisionResult.intersects){
        if(actor.intersects != worldCollisionResult.intersects && actor.accelAccum.y > 2){
            actor.accelAccum.y = 0;
        }
        let gp = GetFlatestTriPoint(worldCollisionResult.groundtripoints);
        if(gp){
            tempUp.set(gp.x, gp.y, gp.z);
            actor.wallriding = false;
        } else {
            let wp = GetFlatestTriPoint(worldCollisionResult.notgroundpoints);
            if(wp && truespeed > actor.wallRideThresholdSqr && actor.accelAccum.lengthSq() > actor.wallRideThresholdSqr){
                actor.wallriding = actor.wallrideangle >= slopelimit;
                tempUp.set(wp.x, wp.y, wp.z);
            }
        }
    }
    actor.gravityAccum += deltaTime * actor.gravity;
    let anglediff = actor.targetup.angleTo(tempUp);
    if(anglediff > slopelimit){
        actor.majorAxisChange = true;
        actor.axisOfChange.copy(actor.targetup).cross(tempUp);
        actor.angleOfChange = anglediff;
    }
    actor.inertiacurr = THREE.MathUtils.clamp(actor.inertiacurr - deltaTime, 0, actor.inertiamax); 
    if(actor.wallriding){
        //reduce inertia resource
        if(isplayer){ 
            inertiaback.style.display = "block";
            inertiabar.style.width = `${actor.inertiacurr/actor.inertiamax * 100}%`;
        }
        if(actor.inertiacurr <= 0){
            tempUp.copy(upVector);
            actor.wallriding = false;
        }
    }else{
        if(surfacehit){
            actor.inertiamax = 0;
        }
        if(actor.inertiamax <= 0 && anglediff > slopelimit){//mainly for transitioning from ground to wall
            let vlength = actor.accelAccum.length() * 0.8 * actor.gravityAccum>0?2:1;
            actor.inertiamax = vlength;
            actor.inertiacurr = vlength;
        }
        if(isplayer){ 
            inertiaback.style.display = "none";
        }
    }
    surfacehit = checkOnSurface(actor, tempUp);
    if(actor.wallriding){
        actor.currRefresh = THREE.MathUtils.clamp(actor.currRefresh - deltaTime, 0, actor.inertiaRefeshTime);
        if(actor.currRefresh <= 0 && surfacehit && !CheckVector3Equals(actor.targetup, surfacehit.normal)){
            actor.inertiacurr = THREE.MathUtils.clamp(actor.inertiacurr + (actor.inertiamax * 0.1), 0, actor.inertiamax); 
            actor.currRefresh = actor.inertiaRefeshTime;
        }
    }
    if(surfacehit){
        if(worldCollisionResult.intersects){
            actor.airNudgeAccum.set(0,0,0);
            if(!actor.wallriding || (actor.wallriding && actor.inertiamax > 0 && actor.inertiacurr > 0)){
                actor.gravityAccum = deltaTime * actor.gravity;
            }
        }
        actor.targetup.copy(surfacehit.normal);
    }
    actor.wallrideangle = actor.targetup.angleTo(upVector);
    actor.intersects = worldCollisionResult.intersects;
}
function SetFacings(actor){
    //set collider
    actor.groundColliderMesh.up.copy(actor.targetup);
    if(actor.majorAxisChange){
        actor.forwardDir.applyAxisAngle(actor.axisOfChange, actor.angleOfChange);
        actor.majorAxisChange = false;
    }
    miscvect.copy(actor.forwardDir).cross(actor.targetup).add(actor.groundColliderMesh.position);
    actor.groundColliderMesh.lookAt(miscvect);
    //set visuals
    if(actor.visualMesh){
        //set up direction
        actor.visualMesh.up.copy(camboom.up);
        //set position
        miscvect.copy(camboom.up).setLength(actor.groundColliderData.radius);
        actor.visualMesh.position.copy(actor.groundColliderMesh.position).sub(miscvect);
        //set facing direction
        if(actor.accelAccum.lengthSq() > 0.1){
            actor.velocityDir.copy(actor.velocity).setLength(1);
        }
        actor.facingDir.copy(actor.velocityDir);
        actor.facingDir.cross(actor.targetup).cross(actor.visualMesh.up);
        //apply facing direction
        miscvect.copy(actor.visualMesh.position).add(actor.facingDir);
        actor.visualMesh.lookAt(miscvect);
    }
}
function UpdateActor(actor, deltaTime, isplayer = false){//updates any actor
    SurfaceDetection(actor, deltaTime, isplayer);//must come before playerControls for surface conforming movement and y rotation to work properly
    if(isplayer){
        playerControls(actor, deltaTime);
        ApplyControls(actor, deltaTime);
        updateCamera(actor, deltaTime);
        teleportPlayerIfOob(actor);
    }
    SetFacings(actor);
    ApplyVelocity(actor);
}
function DoAnimate(){
    clock.update();
    //requestAnimationFrame(animate);
	const deltaTime = Math.min( clock.getDelta(), 0.1 ) / STEPS_PER_FRAME;
    for ( let i = 0; i < STEPS_PER_FRAME; i ++ ) {
        UpdateActor(useplayer, deltaTime, true);
    }
    if(currentscene){
        csm.update();
        outlineEffect.render(currentscene, outlineList, camera);//
        //renderer.render(currentscene, camera);
    }
}
function animate(){
    renderer.setAnimationLoop(DoAnimate) ;
}