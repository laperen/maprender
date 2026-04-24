import * as THREE from 'three';
import { ColliderType } from 'scripts/collision.js';

const RenderStyle = {
    Standard: 0,
    Toon: 1
}
const CollisionTags = {
    Actors: "Actors",
    Environment: "Environment"
}

function CapsuleColliderData(r, h){
    return{
        type: ColliderType.Capsule,
        radius: r,
        height: h,
        segment: new THREE.Line3( new THREE.Vector3(0,0,0), new THREE.Vector3(0,h,0) ),
    }
}
function SphereColliderData(r){
    return{
        type: ColliderType.Sphere,
        radius: r,
        height: 0,
        segment: new THREE.Line3( new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0) ),
    }
}

let player = {
    //rendering settings
    meshpath: "./assets/kazu.glb",
    texturepath: "./assets/kazu_tex.png",
    renderstyle: RenderStyle.Toon,//ignored if texture path isn't provided
    castShadow: false,
    receiveShadow: false,
    //collision settings
    charHeight: 1.7,
    groundColliderData: CapsuleColliderData(0.5, 1),
    collisiontag: CollisionTags.Actors,
    //rendering
    visualMesh: null,
    groundColliderMesh: null,
    //controls
    inputDir: new THREE.Vector3(),
    forwardDir: new THREE.Vector3(),
    intersected: false,
    moving: false,
    jump: false,
    prevJump: false,
    wallDir: null,
    //stats
    gravity: -10,
    maxSpeed: 50,// 20, //mps = meters per second. downhill on rollerblades: 37mps. fastest mobility scooter: 45mps
    airNudge: 10,
    jumpForce: 7,
    wallRideThreshold: 2,
    inertiaRefeshTime: 0.5,
    maxjumpcount: 2,
    //generated
    airMovePercentage: 0,
    wallRideThresholdSqr: 0,
    useHeight: 0,
    maxSpeedSqr: 0,
    airjumpcount: 0,
    //simulation
    targetup: new THREE.Vector3(0,1,0),
    velocity: new THREE.Vector3(),
    velocityDir: new THREE.Vector3(),
    accelAccum: new THREE.Vector3(),
    airNudgeAccum: new THREE.Vector3(),
    gravityAccum: 0,
    inertiamax: 0,
    inertiacurr: 0,
    majorAxisChange: false,
    axisOfChange: new THREE.Vector3(),
    angleOfChange: 0,
    wallrideangle: 0,
    wallriding: false,
    currRefresh: 0,
    //visuals
    facingDir: new THREE.Vector3()
}

let level = {
    //*
    startSpawn: [-15,75,-188],
    env: [
        {
            meshpath: "./assets/PieceOfTokyo.glb",//collision-world2.glb",//TODO figure how to include "collisionpath" to a model specifically for collision
            texturepath: "",
            renderstyle: RenderStyle.Toon,//ignored if texture path isn't provided
            collisiontag: CollisionTags.Environment,
            castShadow: true,
            receiveShadow: true,
            position: [0,0,0]
        }
    ]
    //*/
    
    /*
    startSpawn: [0,2,0],
    env: [
        {
            meshpath: "./assets/collision-world2.glb",
            texturepath: "",
            renderstyle: RenderStyle.Toon,//ignored if texture path isn't provided
            collisiontag: CollisionTags.Environment,
            castShadow: true,
            receiveShadow: true,
            position: [0,0,0]
        }
    ]
    //*/

}
export {RenderStyle, CollisionTags, player, level};