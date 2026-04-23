import * as THREE from 'three';
import { miscvect, upVector, slopelimit } from 'scripts/utilproperties.js';

const ColliderType = {
    Sphere: 0,
    Capsule: 1
}
let world = {
    spawnpoint: [0,0,0],
    layers: {}
};
let tempBox = new THREE.Box3();
let tempMat = new THREE.Matrix4();
let tempSegment = new THREE.Line3();
let tempVector2 = new THREE.Vector3();
let triclone = new THREE.Triangle();

function WorldCollision(actor, collisionTag, deltaPosition){
	// adjust player position based on collisions
    actor.groundColliderMesh.updateMatrixWorld();
    tempBox.makeEmpty();
    tempMat.copy(world.layers[collisionTag].collider.matrixWorld).invert();
    switch(actor.groundColliderData.type){
        case ColliderType.Sphere:
        case ColliderType.Capsule:
            tempSegment.copy(actor.groundColliderData.segment);
            // get the position of the capsule in the local space of the collider
            tempSegment.start.applyMatrix4( actor.groundColliderMesh.matrixWorld ).applyMatrix4( tempMat );
            tempSegment.end.applyMatrix4( actor.groundColliderMesh.matrixWorld ).applyMatrix4( tempMat );
            // get the axis aligned bounding box of the capsule
            tempBox.expandByPoint( tempSegment.start );
            tempBox.expandByPoint( tempSegment.end );
            tempBox.min.addScalar( - actor.groundColliderData.radius );
            tempBox.max.addScalar( actor.groundColliderData.radius );
            break;
    }
	let gtp = [];
	//let ctp = [];
	//let wtp = [];
	let tp = [];
	let ngtp = [];
	world.layers[collisionTag].collider.geometry.boundsTree.shapecast( {
		intersectsBounds: box => box.intersectsBox( tempBox ),
		intersectsTriangle: tri => {
			// check if the triangle is intersecting the capsule and adjust the
			// capsule position if it is.
			const triPoint = deltaPosition;
			const capsulePoint = tempVector2;
			const distance = tri.closestPointToSegment( tempSegment, triPoint, capsulePoint );
			if ( distance < actor.groundColliderData.radius ) {
				const depth = actor.groundColliderData.radius - distance;
				const direction = capsulePoint.sub( triPoint ).normalize();

				tempSegment.start.addScaledVector( direction, depth );
				tempSegment.end.addScaledVector( direction, depth );

				tri.getNormal(miscvect);
				
				//let ysq = miscvect.y * miscvect.y;
				//let xz =  (miscvect.x * miscvect.x) + (miscvect.z * miscvect.z);
				triclone.copy(tri);
				let mini = {
					x: miscvect.x,
					y: miscvect.y,
					z: miscvect.z
				};
				tp.push(mini);
				//if(ysq > xz){
				if(upVector.angleTo(miscvect) < slopelimit){//ground tri points not being properly discerned, but ignoring that for now to fix camera rotation
					if(mini.y < 0){
						//ctp.push(mini);
						ngtp.push(mini);
					}else{
						gtp.push(mini);
					}
				}else{
					if(mini.y >= 0 ){
						//wtp.push(mini);
						ngtp.push(mini);
					}
				}
			}
		}
	} );

	// get the adjusted position of the capsule collider in world space after checking
	// triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
	// the origin of the player model.
	const newPosition = deltaPosition;
	newPosition.copy( tempSegment.start ).applyMatrix4( world.layers[collisionTag].collider.matrixWorld );
	// check how much the collider was moved
	const deltaVector = tempVector2;
	deltaVector.subVectors( newPosition, actor.groundColliderMesh.position );
	const offset = Math.max( 0.0, deltaVector.length() - 1e-5 );
	deltaVector.normalize().multiplyScalar( offset );
    return {
        intersects: deltaVector.lengthSq() > 0,
        delta: deltaVector,
		tripoints: tp,
		groundtripoints: gtp,
		//ceiltripoints: ctp,
		//walltripoints: wtp,
		notgroundpoints: ngtp
    }
}
function GetFlatestTriPoint(list){
	if(null == list || list.length <= 0){
		return null;
	}
    let ycheck = -1;
	let retval;
    for(let i = 0, max = list.length; i < max; i++){
        let tri = list[i];
        if(tri.y > ycheck){
            ycheck = tri.y;
            retval = tri;
        }
    }
	return retval;
}
function teleportPlayerIfOob(actor) {
    if ( actor.groundColliderMesh.position.y <= - 25 ) {
		actor.accelAccum.set(0,0,0);
		actor.airNudgeAccum.set(0,0,0);
		actor.gravityAccum = 0;
		actor.targetup.copy(upVector);
        actor.groundColliderMesh.position.set(world.spawnpoint[0], world.spawnpoint[1], world.spawnpoint[2]);
    }
}
export { ColliderType, world, WorldCollision, teleportPlayerIfOob, GetFlatestTriPoint };