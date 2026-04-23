const githubhash = "";

document.addEventListener('DOMContentLoaded', doBtnBinds);
document.addEventListener('DOMContentLoaded', () => {
	void main().catch((err) => {
		console.error('main() failed:', err);
	});
});
let quill;

const timeouts = {};
function addTimeout(f, timeout) {
	clearTimeout(timeouts[f.name]); // clear existing timeout for same function name
	timeouts[f.name] = _setTimeout(f, timeout);
}
function clearTimeouts() {
	for (const t of Object.values(timeouts)) {
		clearTimeout(t);
	}
}
const _setTimeout = setTimeout;
setTimeout = addTimeout;

function doBtnBinds() {
	// bind buttons with class btn-bind to a function equivalent to the button's id
	Array.from(document.getElementsByClassName('btn-bind')).forEach((el) => {
		const id = el.id;
		if (id == null || id.trim().length == 0) return console.error('this btn-bind does not have an id', el);
		if (!window[id] || typeof window[id] != 'function') return console.error('button', id, 'does not have a matching function');
		el.addEventListener('click', window[id]); // assign the function with the same name
	});
}

async function main() {
	console.log('app.js main() starting');

	if (window.location.pathname === '/auth') {
		history.replaceState(null, '', '/');
	}
}