const electron = require('electron');
const url = require('url');
const path = require('path');
const exec = require('child_process');

const {app, BrowserWindow, Menu, ipcMain, dialog} = electron;

// Global vars
let mainWindow;
let generateWindow;
let unlockWindow;

let currentWalletPath;
let currentSaveWalletPath;


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
        path.join(__dirname, 'bin', 'win32', 'simplewallet.exe'),
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

    genWallet.on('close', (code) => {
        console.log('finished generating wallet');
    });
});

ipcMain.on('wallet:sendCommand', (event, data) => {
    sendWalletCommand(data.command);
});

ipcMain.on('wallet:unlock', (event, item) => {
    unlockWindow.close();
    stopWallet();
    startWallet(currentWalletPath, item.password);
    walletCmdQueue.push('address');
    walletCmdQueue.push('balance');
});

// Daemon
let daemon;
let wallet;
let walletReady = false;
let walletCommand = null;
let walletAddress = null;
let walletCmdQueue = [];

function startDaemon() {
    if (daemon) {
        console.log('daemon seems already started.');
        return;
    }

    daemon = exec.spawn('./bin/win32/m0rkcoind.exe');

    daemon.stdout.on('data', (data) => {
        logDaemonMessage(data);
    });

    daemon.stderr.on('data', (data) => {
        logDaemonMessage(data);
    });
        
    daemon.on('close', (code, status) => {
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

function logWalletMessage(message) {
    console.log('wallet: ' + message);
    if (mainWindow) {
        mainWindow.webContents.send('walletUpdate', {'message': message});
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
function isWalletReady(sData) {
    return RegExp("\\[wallet fmrk[\\d\\w]{2}\\]:").exec(sData) !== null
}

function setWalletReady(isReady) {
    walletReady = isReady;
    mainWindow.webContents.send('walletReady', {walletReady: isReady});
}

function parseWalletOutput(sData) {
    if (!walletAddress){
        const walletAddressRegEx = RegExp("Opened wallet: (fmrk[\\w\\d]{95})");
        const match = sData.match(walletAddressRegEx);
        if (match) {
            walletAddress = match[1];
            sendWalletAddressToFrontend();
        }
    }

    if (walletCommand === "address") {
        const walletAddressRegEx = RegExp("INFO    (fmrk[\\w\\d]{95})");
        const match = sData.match(walletAddressRegEx);
        if (match) {
            walletAddress = match[1];
            console.log('Address is: ' + walletAddress);
            sendWalletAddressToFrontend();
        }
    } else if (walletCommand === "balance") {
        const balanceRegEx = RegExp("available balance: (\\d+\\.\\d{12}), locked amount: (\\d+\\.\\d{12})");
        const match = sData.match(balanceRegEx);
        if (match) {
            sendWalletBalanceToFrontend(match[1], match[2]);
        }
    } else if (walletCommand === "exit") {
        console.log("EXIT");
    }
}

function startWallet(file, password) {
    if (wallet) {
        console.log('wallet is already running');
        return;
    }

    wallet = exec.spawn(
       path.join(__dirname, 'bin', process.platform, 'simplewallet.exe'),
       ['--wallet-file', file, '--password', password]);
    
    wallet.stdout.on('data', (data) => {
        setWalletReady(false);
        let sData = data.toString();

        logWalletMessage(sData);
        parseWalletOutput(sData);

        if (isWalletReady(sData)) {
            console.log("WALLET READY");
            walletCommand = null;

            if (walletCmdQueue.length > 0) {
                sendWalletCommand(walletCmdQueue[0]);
                walletCmdQueue.shift();
            } else {
                setWalletReady(true);
            }
        }
    });

    wallet.stderr.on('data', (data) => {
        console.log('stderr: ' + data.toString());
    });

    wallet.on('close', (code, signal) => {
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

function sendWalletCommand(command) {
    if (!wallet) {
        console.log('wallet is not running');
        return;
    }
    walletCommand = command;
    setWalletReady(false);
    console.log('sending command: ' + command);
    wallet.stdin.write(command + '\n');
}
