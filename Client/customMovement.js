
function checkOnSurface(actor, normal){
    charraycaster.ray.origin.copy(actor.groundColliderMesh.position);
    miscvect.copy(normal);
    charraycaster.ray.direction.copy(miscvect.negate());
    return charraycaster.intersectObject(world.layers[CollisionTags.Environment].collider)[0];
}
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