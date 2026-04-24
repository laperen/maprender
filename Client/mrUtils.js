import * as THREE from 'three';

let miscs = []
let usedMiscs = 0;
function StartCloneUse(){
  usedMiscs = 0;
}
function CloneVector3(vect3){
  if(usedMiscs >= miscs.length){
    miscs.push(new THREE.Vector3());
  }
  miscs[usedMiscs].copy(vect3);
  usedMiscs++;
  return miscs[usedMiscs-1];
}

export {StartCloneUse,CloneVector3};