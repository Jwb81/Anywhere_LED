const http      = require('http').createServer();
const fs        = require('fs');
const io        = require('socket.io')(http)
const cors      = require('cors');

cors();

const prod = process.argv[2] === 'production';

// let Gpio;

// if (prod) {
//     Gpio = require('pigpio').Gpio;
// }


const PORT = 3000;

// const digitalOn = 1;
// const digitalOff = 0;

const sockets = {};

let db = {};

// let onboardLeds = {};
// if (prod) {
//     onboardLeds = {
//         red: new Gpio(17, { mode: Gpio.OUTPUT }),
//         green: new Gpio(22, { mode: Gpio.OUTPUT }),
//         blue: new Gpio(24, { mode: Gpio.OUTPUT }),
//     }
// }

    
const remoteTemplate = {
    id: null,
    name: ``,
    active: false,
    connected: false,
    rgb: {
        red: 0,
        green: 0,
        blue: 0,
    },
    groups: []
}


// read and write pi and RGB values locally instead of using a database for now
const writeJson = (filename, data, cb) => {
    fs.writeFile(filename, JSON.stringify(data, null, 4), err => {
    	cb(err);
    })
}

const readJson = (filename, cb) => {
    fs.readFile(filename, 'utf8', (err, data) => {
        if (err) {
            return cb(err, null);
        }
        return cb(null, JSON.parse(data));
        // return JSON.parse(data);
    })
}

const writeDbToFile = () => {
	writeJson('./db.json', db, err => {
		if (err) {
			console.log(err);
		}
	})
}


const updateRemote = (data) => {
    if (!prod) { return }

    const { lights, rgb } = data;

    if (lights.includes(1)) {
        changeOnboardLeds(rgb);
    }

    // change this remote pi's values in the global object
    const { red, green, blue } = rgb;
    db.lights = db.lights.map(l => {
        if (lights.includes(l.id)) {
            l.rgb.red = Number(red);
            l.rgb.green = Number(green);
            l.rgb.blue = Number(blue);
        }
        return l;
    });

    // filter out 1 since that is the onboard LED
    const affected = lights.filter(id => id !== 1);

    lights.forEach(id => {
        const lightIdx = db.lights.findIndex(l => l.id === id);
        db.lights[lightIdx].active = true;
        io.emit('update-light', {
            id,
            active: db.lights[lightIdx].active
        })
    })

    // send the value to all affected satellites
    affected.forEach(id => {
    	try {
			const lightIdx = db.lights.findIndex(l => l.id === id);
            sockets[id] && sockets[id].emit('change-leds', { rgb: db.lights[lightIdx].rgb, active: db.lights[lightIdx].active });
            db.lights[lightIdx].active = true;
            io.emit('update-light', {
                id,
                active: db.lights[lightIdx].active
            })
    	}
    	catch (e) {
    		console.log(e)
    	}
    })   

    writeDbToFile(); 
}


const updateLightStatus = data => {
    const { id } = data;
    const lightIdx = db.lights.findIndex(l => l.id === id);
 
    if (db.lights[lightIdx].active) {
        db.lights[lightIdx].active = false;
    } else {
        db.lights[lightIdx].active = true;
    }

    io.emit('update-light', {
        id,
        active: db.lights[lightIdx].active
    })

    if (prod && sockets[id]) {
        sockets[id].emit('change-leds', { rgb: db.lights[lightIdx].rgb, active: db.lights[lightIdx].active });
    }

    writeDbToFile();
}

const runScene = data => {
	const { id } = data;
    const scene = db.scenes.find(scene => scene.id === id);

	const affectedLights = scene.lights;
	affectedLights.forEach(l => {
        const lightIdx = db.lights.findIndex(lit => lit.id === l.id);
        
        if (lightIdx === -1) {
            return
        }
        
        db.lights[lightIdx].active = true;
        db.lights[lightIdx].rgb = Object.assign({}, l.rgb);
        io.emit('update-light', {
            id: l.id,
            active: db.lights[lightIdx].active
        })

		sockets[l.id] && sockets[l.id].emit('change-leds', {
			rgb: l.rgb,
			active: true
		})
	})

	writeDbToFile();
}

const filterLightFromScene = id => {
    db.scenes = db.scenes.map(scene => {
        // filter out the light from the associated lights
        scene.lights = scene.lights.filter(l => l.id !== id);
        return scene;
    })
    writeDbToFile();
}

const deleteLight = (data, socket) => {
    const { id } = data;
    db.lights = db.lights.filter(l => l.id !== id);
    io.sockets.emit('light-deleted', {
        id
    })
    filterLightFromScene(id);
    writeDbToFile();
}

const updateLight = (data, socket) => {
    const { light } = data;
    const idx = db.lights.findIndex(l => l.id === light.id);
    db.lights[idx] = light;
    io.sockets.emit('update-light-info', {
        light
    })
    writeDbToFile();
}

const deleteScene = (data, socket) => {
    const { id } = data;
    db.scenes = db.scenes.filter(s => s.id !== id);
    io.sockets.emit('scene-deleted', {
        id
    })
    writeDbToFile();
}

const updateScene = data => {
    const { scene } = data;
    const idx = db.scenes.findIndex(s => s.id === scene.id);
    db.scenes[idx] = scene;
    io.sockets.emit('scene-updated', {
        scene
    })
    writeDbToFile();
}

const addScene = data => {
    const { scene } = data;

    // find the max id and add one for this scene
    const max = db.scenes.reduce((prev, cur) => {
        const { id } = cur;
        if (id > prev) {
            return id;
        }
        return prev;
    }, 0);
    const newId = max + 1;
    scene.id = newId;
    
    db.scenes = db.scenes.concat(scene);
    writeDbToFile();
}

const getLightStatus = (data, socket) => {
	const { light } = data;
	const idx = db.lights.findIndex(l => l.id === light.id);
	socket.emit('get-light-rgb-status-for-sliders', {
		light: db.lights[idx]
	})
}

const readDb = () => {
    readJson('db.json', (err, data) => {
        data.lights = data.lights.map(l => {
            l.connected = false;
            return l;
        })

        db = data;

        const connected = db.lights.filter(l => l.connected);
        connected.map(l => {
            updateRemote({
                lights: [l.id],
                rgb: l.rgb
            })
        })
    })
}


// listen for sockets
io.sockets.on('connection', (socket) => {
    let connectionType = 'browser';  // satellite or browser (change it if it is a satellite)
    let mac;
    console.log(`${mac} connected`)

    /**
     * SATELLITE CONNECTION SOCKETS
     */
    
    // inital hit after connection
    socket.on('satellite-init', data => {
        const { macAddr, remoteName } = data;
        console.log(macAddr)

        connectionType = 'satellite';
        mac = macAddr;

        // see if MAC address already exists
        const macIdx = db.lights.findIndex(l => l.id === macAddr)
        if (macIdx < 0) {
            const temp = Object.assign({}, remoteTemplate);
            temp.id = macAddr;
            temp.name = remoteName;
            temp.connected = true;
            db.lights = db.lights.concat(temp);
        } else {
            db.lights[macIdx].connected = true;
            const light = db.lights[macIdx];
            updateRemote({
            	lights: [light.id],
            	rgb: light.rgb
            })
            io.sockets.emit('update-light-info', {
            	light
            })
        }

        writeDbToFile();
        sockets[macAddr] = socket;
    });

    socket.on('disconnect', (data) => {
        if (connectionType === 'satellite') {
            // remove socket
            delete sockets[mac];
            // sockets = sockets[mac] = null;

            // set the `connected` flag to false
            const macIdx = db.lights.findIndex(l => l.id === mac);
            db.lights[macIdx].connected = false;
            writeDbToFile();
        }
    })
    
    
    
    
    /**
     * BROWSER CONNECTION SOCKETS
     */
    
    // send initial data
    socket.emit('browser-reset', { ...db })

    socket.on('update-lights', updateRemote);

    // socket.on('update-light-color', updateLightColor);

    socket.on('toggle-light-switch', updateLightStatus);

    socket.on('run-scene', runScene);

    socket.on('delete-light', data => deleteLight(data, socket));

    socket.on('update-light', data => updateLight(data, socket));
 
    socket.on('delete-scene', data => deleteScene(data, socket));

    socket.on('update-scene', updateScene);

    socket.on('add-scene', addScene);

    socket.on('get-light-rgb-status-for-sliders', data => getLightStatus(data, socket));
    
    socket.on('reread-db', readDb);
})



/**
 * STARTUP FUNCTIONS
 */
readDb();

// start the main server 
http.listen(PORT, () => {
    console.log(`Boo-LED listening on port ${PORT}`);
})

// listen for ctrl + c
process.on('SIGINT', function () {
	writeDbToFile();
    setTimeout(() => {
        process.exit();    
    }, 250);
    
});