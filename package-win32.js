packager = require('electron-packager');

packager({
    dir: '.',
    ignore: [
        RegExp("m0rkcoind\.log"),
        RegExp("simplewallet\.log"),
        RegExp("bin/(darwin|linux)"),
        RegExp("README\.md"),
        RegExp("\.idea"),
        RegExp("\.vscode"),
        RegExp("\.gitignore"),
        RegExp("package-win32.js"),
	RegExp("package-linux.js"),
	RegExp("package-darwin.js"),
        RegExp("todo")
    ],
    out: 'build',
    platform: 'win32'
});
