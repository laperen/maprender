import * as THREE from 'three';

const rad90 = Math.PI/2;
const upVector = new THREE.Vector3( 0, 1, 0 );
const downVector = new THREE.Vector3( 0, -1, 0 );
const miscvect = new THREE.Vector3();
const slopelimit = Math.PI/4;
const vectorepsilon = 0.0005

const clock = new THREE.Timer();

function CheckVector3Equals( v1, v2) {
    return ( ( Math.abs( v1.x - v2.x ) < vectorepsilon ) && ( Math.abs( v1.y - v2.y ) < vectorepsilon ) && ( Math.abs( v1.z - v2.z ) < vectorepsilon ) );
}
export { rad90, upVector, downVector, miscvect, clock, slopelimit, CheckVector3Equals };