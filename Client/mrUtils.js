import * as THREE from 'three';

let miscs = []
let usedMiscs = 0;
const vectorepsilon = 0.0005
const upVector = new THREE.Vector3( 0, 1, 0 );

function StartCloneUse(){
  usedMiscs = 0;
}
function GetMiscVect(x=0,y=0,z=0){
  if(usedMiscs >= miscs.length){
    miscs.push(new THREE.Vector3(x,y,z));
  }
  miscs[usedMiscs].set(x,y,z);
  usedMiscs++;
  return miscs[usedMiscs-1];
}
function CloneVector3(vect3){
  let misc = GetMiscVect();
  misc.copy(vect3);
  return misc;
}
function CheckVector3Equals( v1, v2) {
    return ( ( Math.abs( v1.x - v2.x ) < vectorepsilon ) && ( Math.abs( v1.y - v2.y ) < vectorepsilon ) && ( Math.abs( v1.z - v2.z ) < vectorepsilon ) );
}

export {StartCloneUse,GetMiscVect,CloneVector3,CheckVector3Equals,upVector};