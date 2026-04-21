
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
function LoadObject(ele, loadactions = null, ontraverse = null, onanimations = null){
    gltfloader.load(ele.meshpath, (gltf)=>{
        let mesh = gltf.scene;
        let material = null;
        if(ele.texturepath){
            let texture = textureloader.load(ele.texturepath);
            texture.premultiplyAlpha = false;
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            texture.flipY = false;
            switch(ele.renderstyle){
                case RenderStyle.Standard:
                    break;
                case RenderStyle.Toon:
                    material = new THREE.MeshToonMaterial({
                        color: 0xFFFFFF,
                        map: texture
                    });
                    material.userData.outlineParameters = {
                        thickness: 0.005//outline thickness
                    };
                break;
            }
        }
        const box = new THREE.Box3();
        box.setFromObject( mesh );
        box.getCenter( mesh.position ).negate();
        mesh.updateMatrixWorld( true );

        mesh.traverse((model)=>{
            if(model.isMesh){
                if(material){
                    model.material = material;
                }else{
                    model.material = new THREE.MeshPhongMaterial({
                        color: model.material.color,
                        map: model.material.map
                    });
                }
                model.material.side = THREE.FrontSide;
                if(ontraverse){
                    ontraverse(model);
                }
                csm.setupMaterial(model.material);
            }
        });
        if(onanimations){
            //mixer and animations for ele
            onanimations(gltf.animations);
        }
        if(ele.position && ele.position.length == 3){
            mesh.position.set(ele.position[0], ele.position[1], ele.position[2]);
        }
        if(loadactions){
            loadactions(mesh);
        }
    });
}
function LoadActor(scene, data, pos, onload){
    function NewGeometry(ctype){
        switch(ctype){
        case ColliderType.Sphere:
            return new THREE.Mesh(new THREE.SphereGeometry(data.groundColliderData.radius, 8, 6), new THREE.MeshStandardMaterial());
        case ColliderType.Capsule:
            return new THREE.Mesh(new THREE.CapsuleGeometry(data.groundColliderData.radius, data.groundColliderData.height, 2, 8), new THREE.MeshStandardMaterial());
        }
        return null;
    }
    data.groundColliderMesh = NewGeometry(data.groundColliderData.type), new THREE.MeshStandardMaterial();
    if(data.groundColliderMesh){
        data.groundColliderMesh.visible = true;//false
        data.groundColliderMesh.position.set(pos[0], pos[1], pos[2]);
        //data.groundColliderMesh.rotation.order = 'YXZ';
    }
    data.airMovePercentage = (data.maxSpeed-data.airNudge)/data.maxSpeed;
    data.useHeight = data.charHeight - data.groundColliderData.radius;
    data.maxSpeedSqr = data.maxSpeed * data.maxSpeed;
    data.wallRideThresholdSqr = data.wallRideThreshold * data.wallRideThreshold;

    LoadObject(data, (vmesh)=>{
        outlineList.push(vmesh);
        data.visualMesh = vmesh;
        scene.add(vmesh);
        //scene.add(data.groundColliderMesh);
        if(onload){
            onload(data);
        }
    });
}