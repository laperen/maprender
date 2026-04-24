import * as THREE from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { animate, camera, ChangePlayer, csm } from 'scripts/game.js';
import { ColliderType, world } from 'scripts/collision.js';
import { RenderStyle, CollisionTags, player } from 'scripts/GameObjects.js';
import { SetLoadingBar } from 'scripts/gui.js';
import {InitSky, SetSkyValues, InitCloud, SetCloudValues} from 'scripts/atmosphere.js';

const clearcol = "#bfebec";
const textureloader = new THREE.TextureLoader();

const loadingMgr = new THREE.LoadingManager();
let arrowHelper;
const camboom = new THREE.Group();
camboom.rotation.set(0,0,0);
const camvert =  new THREE.Group();
camboom.add(camvert);
camvert.rotation.set(0,0,0);

loadingMgr.onProgress = function(url, loaded, total){
    if(loaded >= total){
        SetLoadingBar(100);
        return;
    }
    SetLoadingBar(Math.floor(loaded/total) * 100);
}
const gltfloader = new GLTFLoader(loadingMgr);
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
function SetupCamera(actor){
    camvert.position.set(0,actor.useHeight,0);
    camera.rotation.set(0,0,0);
    camera.position.set(0,0, 2);
}
let outlineList;
const blobshadow = new THREE.SpotLight(0xffffff,-1,100,5,0.5,0);
blobshadow.castShadow = false;
blobshadow.shadow.mapSize.width = 256;
blobshadow.shadow.mapSize.height = 256;
function PreloadScene(renderer, data){
    world.spawnpoint = data.startSpawn;

    let newscene = new THREE.Scene();
    newscene.fog = new THREE.FogExp2(clearcol, 0.0005);//exponential fog
    
    const fillLight1 = new THREE.HemisphereLight( 0x8dc1de, 0x00668d, 1.5 );
    fillLight1.position.set( 2, 1, 1 );
    newscene.add( fillLight1 );
    
    InitSky(newscene);
    SetSkyValues(renderer, 0, 0.3, 0.005, 0.3, 50, 0, renderer.toneMappingExposure);
    let cloud = InitCloud(newscene);
    SetCloudValues(cloud, 
        0,1000,-2000, //typical cloud height is double
        500, 100, 500, //apparant typical cloud size is double
        0.25, 0.25, 0.1, 100
    );
    /*
    const directionalLight = new THREE.DirectionalLight( 0xffffff, 2.5 );
    directionalLight.position.set( - 5, 25, - 1 );
    directionalLight.castShadow = true;
    
    directionalLight.shadow.camera.near = 0.01;
    directionalLight.shadow.camera.far = 500;
    directionalLight.shadow.camera.right = 30;
    directionalLight.shadow.camera.left = - 30;
    directionalLight.shadow.camera.top	= 30;
    directionalLight.shadow.camera.bottom = - 30;
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    directionalLight.shadow.radius = 4;
    directionalLight.shadow.bias = - 0.00006;

    newscene.add(directionalLight);
    */

    /*
    const axeshelper = new THREE.AxesHelper(5);
    newscene.add(axeshelper);
    const gridhelper = new THREE.GridHelper();
    newscene.add(gridhelper);
    //*/
    outlineList = [];
    for(let i = 0, max = data.env.length; i < max; i++){
        let ele = data.env[i];
        LoadObject(ele, (mesh)=>{
            if(!world.layers[ele.collisiontag]){
                world.layers[ele.collisiontag] = { 
                    visual: new THREE.Group() ,
                    collider: null
                };
            }
            world.layers[ele.collisiontag].visual.attach(mesh);
            if(i >= (data.env.length-1)){
                let keys = Object.keys(world.layers);
                for(let c = 0, cmax = keys.length; c < cmax; c++){
                    let key = keys[c];
                    world.layers[key].visual.updateMatrixWorld(true);
                    const staticGenerator = new StaticGeometryGenerator(world.layers[key].visual);
                    staticGenerator.attrbutes = ['position'];
                    
                    const mergedGeometry = staticGenerator.generate();
                    mergedGeometry.boundsTree = new MeshBVH( mergedGeometry );
                    
                    world.layers[key].collider = new THREE.Mesh( mergedGeometry );
                    /*
                    world.layers[key].collider.visible = false;
                    world.layers[key].collider.material.wireframe = true;
                    world.layers[key].collider.material.opacity = 0.5;
                    world.layers[key].collider.material.transparent = true;
                    newscene.add( world.layers[key].collider );
                    //*/
                    arrowHelper = new THREE.ArrowHelper();
                    arrowHelper.setColor(0xff0000);
                    arrowHelper.setLength(1);
                    
                    newscene.add(arrowHelper);
                    switch(key){
                        case CollisionTags.Actors:
                        case CollisionTags.Environment:
                            newscene.add( world.layers[ele.collisiontag].visual );
                            break;
                        default:
                            break;
                    }
                }
                LoadActor(newscene, player, world.spawnpoint, (data)=>{
                    //TODO use spotlight with negative intensity to use as player's drop shadow.
                    /*
                    data.visualMesh.add(blobshadow);
                    blobshadow.position.set(0,3,0);
                    blobshadow.target = data.visualMesh;
                    */
                });
                ChangePlayer(player);
                
                camvert.add(camera);
                

                animate();
            }
        },(model)=>{
            model.castShadow = ele.castShadow;
            model.receiveShadow = ele.receiveShadow;
        });
    }
    return newscene;
}
export { PreloadScene, arrowHelper, clearcol, camboom, camvert, SetupCamera, outlineList };