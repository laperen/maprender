import * as THREE from 'three';

let miscs = []
let usedMiscs = 0;
function StartCloneUse(){
  usedMiscs = 0;
}
function GetMiscVect(){
  if(usedMiscs >= miscs.length){
    miscs.push(new THREE.Vector3());
  }
  usedMiscs++;
  return miscs[usedMiscs-1];
}
function CloneVector3(vect3){
  let misc = GetMiscVect();
  misc.copy(vect3);
  return misc;
}

export {StartCloneUse,GetMiscVect,CloneVector3};