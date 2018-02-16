const electron = require('electron');
const url = require('url');
const path = require('path');
const exec = require('child_process');
const request = require('request');

const {app, BrowserWindow, Menu, ipcMain, dialog} = electron;

// Global vars
let mainWindow;
let generateWindow;
let unlockWindow;

let currentWalletPath;
let currentSaveWalletPath;

let _simpleWalletPath;
let _daemonPath;

if (process.platform === 'win32') {
    _simpleWalletPath = path.join(__dirname, "bin", process.platform, "simplewallet.exe");
    _daemonPath = path.join(__dirname, "bin", process.platform, "m0rkcoind.exe");
} else {
    _simpleWalletPath = path.join(__dirname, "bin", process.platform, "simplewallet");
    _daemonPath = path.join(__dirname, "bin", process.platform, "m0rkcoind");
}

const simpleWalletPath = _simpleWalletPath;
const daemonPath = _daemonPath;

const walletRpcPort = "18598";
const walletRpcAddress = `http://127.0.0.1:${walletRpcPort}/json_rpc`;


const mainMenuTemplate = [
    {
        label: 'File',
        submenu: [
            {
                label: 'Open Wallet',
                accelerator: process.platform === 'darwin' ? 'Command+O' : 'Ctrl+O',
                click() {
                    openWalletSelectDialog();
                }
            },
            {
                label: 'Generate Wallet',
                accelerator: process.platform === 'darwin' ? 'Command+G' : 'Ctrl+G',
                click() {
                    openGenerateWindow();
                }
            },
            {
                label: 'Quit',
                accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q',
                click() {
                    app.quit();
                }
            }
        ]
    }
];

if (process.platform === 'darwin') {
    mainMenuTemplate.unshift({});
}

if (process.env.NODE_ENV !== 'production') {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
    mainMenuTemplate.push({
        label: 'Dev Tools',
        submenu: [
            {
                label: 'Open Dev Tools',
                accelerator: process.platform === 'darwin' ? 'Command+I' : 'Ctrl+I',
                click(item, focusedWindow){
                    focusedWindow.toggleDevTools();
                }
            },
            {
                role: 'reload',
                accelerator: process.platform === 'darwin' ? 'Command+R' : 'Ctrl+R'
            }
        ]
    })
}

function createWindow() {
    mainWindow = new BrowserWindow({width: 1000, height:650});

    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    mainWindow.on('closed', () => {
        if (generateWindow) {
            generateWindow.close();
        }
        if (unlockWindow) {
            unlockWindow.close();
        }
        mainWindow = null;
    });

    const mainMenu = Menu.buildFromTemplate(mainMenuTemplate);

    Menu.setApplicationMenu(mainMenu);

    startDaemon();
}

function openGenerateWindow() {
    let savePath = dialog.showSaveDialog({
        title: 'Select a location for your wallet',
        buttonLabel: 'Select',
        defaultPath: 'wallet',
        filters: [{
            name: 'Wallet',
            extensions: ["wallet"]
        }]
    });

    if (!savePath) {
        console.log('generation aborted by user');
        return;
    }

    if (savePath.endsWith('.wallet')) {
        savePath = savePath.substring(0, savePath.length - 7);
    }

    currentSaveWalletPath = savePath;

    generateWindow = new BrowserWindow({width: 345, height: 320});
    generateWindow.setMenu(null);
    generateWindow.setResizable(false);

    generateWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'generate_window.html'),
        protocol: 'file:',
        slashes: true
    }));

    generateWindow.on('closed', () => {
        generateWindow = null;
    });
}

function openUnlockWindow() {
    unlockWindow = new BrowserWindow({width: 325, height: 255});
    unlockWindow.setMenu(null);
    unlockWindow.setResizable(false);

    unlockWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'password_prompt.html'),
        protocol: 'file:',
        slashes: true
    }));

    unlockWindow.on('closed', () => {
        unlockWindow = null;
    });
}

function openWalletSelectDialog() {
    const filePaths = dialog.showOpenDialog({
        title: "Select a wallet file",
        filters: [{
            name: "Wallet",
            extensions: ["wallet"]
        }],
        properties: ["openFile"]
    });

    let walletPath;

    if (filePaths && filePaths.length > 0) {
        walletPath = filePaths[0];
        console.log(walletPath);
    }

    if (walletPath.endsWith('.wallet')) {
        walletPath = walletPath.substring(0, walletPath.length - 7);
    }

    currentWalletPath = walletPath;

    openUnlockWindow();
}

// App events
app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    if (daemon) {
        stopDaemon();
    }
    if (wallet) {
        stopWallet();
    }
});

// Events
ipcMain.on('wallet:generate', (event, item) => {
    generateWindow.close();
    console.log('generating wallet with password: ' + item.password);
    let genWallet = exec.spawn(
        simpleWalletPath,
        ['--generate-new-wallet', currentSaveWalletPath, '--password', item.password]);

    genWallet.stdout.on('data', (data) => {
        console.log('generate wallet stdout: ' + data);
        const sData = data.toString();
        const walletAddressRegEx = RegExp("Generated new wallet: (fmrk[\\w\\d]{95})");
        const match = sData.match(walletAddressRegEx);
        if (match) {
            let walletAddress = match[1];
            console.log("Address: " + walletAddress);
        }

        if (RegExp("\\[wallet fmrk[\\d\\w]{2}\\]:").exec(sData) !== null) {
            genWallet.kill("SIGINT");
            genWallet = null;
        }
    });

    genWallet.stderr.on('data', (data) => {
        console.log('generate wallet stderr: ' + data);
    });

    genWallet.on('close', () => {
        console.log('finished generating wallet');
    });
});

ipcMain.on('wallet:unlock', (event, item) => {
    unlockWindow.close();
    stopWallet();
    startWallet(currentWalletPath, item.password);
    rpcGetAddress();
    rpcGetBalance();
});

// Daemon
let daemon;
let wallet;
let walletAddress = null;

function startDaemon() {
    if (daemon) {
        console.log('daemon seems already started.');
        return;
    }

    daemon = exec.spawn(daemonPath);

    daemon.stdout.on('data', (data) => {
        logDaemonMessage(data);
    });

    daemon.stderr.on('data', (data) => {
        logDaemonMessage(data);
    });
        
    daemon.on('close', (code) => {
        logDaemonMessage(`Daemon exited with code: ${code}\n`);
    });
}

function stopDaemon() {
    if (!daemon) {
        console.log('daemon is not running.');
        return;
    }

    daemon.kill('SIGINT');
    daemon = null;
}

function logDaemonMessage(message) {
    console.log('daemon: ' + message);
    if (mainWindow) {
        mainWindow.webContents.send('daemonUpdate', {'message': message});
    }
}

function sendWalletAddressToFrontend() {
    if (mainWindow) {
        mainWindow.webContents.send('walletAddress', {address: walletAddress});
    }
}

function sendWalletBalanceToFrontend(available, locked) {
    if (mainWindow) {
        mainWindow.webContents.send('walletBalance', {
            available: available,
            locked: locked
        });
    }
}

// Wallet
function sendRpcCommand(command, params, callback) {
    request.post({
        url: walletRpcAddress,
        json: {
            jsonrpc: "",
            method: command,
            params: params
        }
    }, callback);
}

function rpcGetAddress() {
    sendRpcCommand('get_address', {}, (error, response, body) => {
        if (response.statusCode === 200) {
            walletAddress = body.result.address;
            sendWalletAddressToFrontend();
        } else {
            console.log(`Error: ${response.statusCode}, ${body}`)
        }
    });
}

function rpcGetBalance() {
    sendRpcCommand('getbalance', {}, (error, response, body) => {
        if (response.statusCode === 200) {
            let availableBalance = body.result.available_balance;
            let lockedBalance = body.result.locked_amount;
            sendWalletBalanceToFrontend(availableBalance, lockedBalance);
        } else {
            console.log(`Error: ${response.statusCode}, ${body}`)
        }
    });
}

function startWallet(file, password) {
    if (wallet) {
        console.log('wallet is already running');
        return;
    }

    wallet = exec.spawn(
       simpleWalletPath,
       ['--wallet-file', file, '--password', password, '--rpc-bind-port', walletRpcPort]);

    wallet.on('close', (code) => {
        console.log(`wallet exited with code ${code}`);
    });
}

function stopWallet() {
    if (!wallet) {
        console.log('wallet is not running');
        return;
    }

    wallet.kill('SIGINT');
    wallet = null;
}
