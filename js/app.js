const githubhash = "";

document.addEventListener('DOMContentLoaded', doBtnBinds);
document.addEventListener('DOMContentLoaded', main);

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
	try {
		console.log('app.js main() starting');
		if (window.esi?.ready) {
			await window.esi.ready;
		}
		if (!window.esi) {
			throw new Error('ESI initialization failed or not available');
		}

		switch (window.location.pathname) {
			case '/auth':
				break;
			case '/login-check':
				if (window.esi.whoami === null) {
					console.log('not logged in');
					return await window.esi.authBegin();
				}
				break;
			default:
		}

		// Check if user is logged in
		if (window.esi.whoami === null) {
			// Not logged in: load and render README
			await loadReadme();
			document.getElementById('about').classList.remove('d-none');
			return;
		}
	} catch (err) {
		console.error('Error in main():', err);
		document.getElementById('about').innerHTML = '<p>Error during initialization. <a href="/login">Click here to login</a>.</p>';
		document.getElementById('about').classList.remove('d-none');
		return;
	}
}

async function loadReadme() {
	try {
		const response = await fetch('/README.md');
		if (!response.ok) throw new Error(`Failed to fetch README: ${response.status}`);
		const markdown = await response.text();
		
		// Wait for marked.js to load
		if (typeof marked === 'undefined') {
			console.warn('marked.js not loaded yet, retrying...');
			await new Promise(resolve => setTimeout(resolve, 100));
			return loadReadme();
		}
		
		// Convert markdown to HTML and inject
		const html = marked.parse(markdown);
		const about = document.getElementById('about');
		about.innerHTML = html;
		// Rewrite skillq.net URLs to local paths
		about.querySelectorAll('a[href^="https://skillq.net/"]').forEach(a => {
			a.href = a.getAttribute('href').replace('https://skillq.net', '');
		});
		about.querySelectorAll('img[src^="https://skillq.net/"]').forEach(img => {
			img.src = img.getAttribute('src').replace('https://skillq.net', '');
		});
	} catch (err) {
		console.error('Failed to load README:', err);
		document.getElementById('about').innerHTML = '<p>Error loading README. <a href="/login">Click here to login</a>.</p>';
	}
}