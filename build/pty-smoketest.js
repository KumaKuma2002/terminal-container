// Headless Electron smoke test: confirm node-pty loads under Electron's ABI and can spawn a shell.
const { app } = require('electron');

app.whenReady().then(() => {
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    console.error('PTY_LOAD_FAIL: ' + e.message);
    app.exit(2);
    return;
  }
  let out = '';
  const marker = 'PTY_' + 'OK';
  try {
    const p = pty.spawn(process.env.SHELL || '/bin/zsh', [], { cols: 80, rows: 24, cwd: process.env.HOME });
    p.onData((d) => {
      out += d;
      if (out.includes(marker)) {
        console.log('PTY_SPAWN_OK');
        try { p.kill(); } catch (_) {}
        app.exit(0);
      }
    });
    p.write('echo ' + marker + '\r');
    setTimeout(() => {
      console.error('PTY_TIMEOUT partial=' + JSON.stringify(out.slice(0, 80)));
      app.exit(1);
    }, 5000);
  } catch (e) {
    console.error('PTY_SPAWN_FAIL: ' + e.message);
    app.exit(3);
  }
});
