export function run(code: string) {
	return eval(code);
}

export const make = new Function('a', 'return a');

// eval(commented) must not be reported

window.addEventListener('message', (e) => {
	console.log(e.data);
});

window.addEventListener('message', (event) => {
	if (event.origin !== 'https://trusted.example') return;
	console.log(event.data);
});

export function listen(ws: WebSocket) {
	ws.addEventListener('message', (m) => console.log(m.data));
}

export function save(token: string) {
	localStorage.setItem('authToken', token);
	localStorage.setItem('theme', 'dark');
}
