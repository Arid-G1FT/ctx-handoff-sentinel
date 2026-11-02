const r = await fetch('https://api.github.com/user', { headers: { authorization: 'token ' + process.env.GH_TOKEN, 'user-agent': 'ctx-guard-setup', accept: 'application/vnd.github+json' } });
const body = await r.json();
console.log('status', r.status, 'login', body.login ?? body.message);
