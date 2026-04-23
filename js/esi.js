window.esi = null;

const APP_NAME = 'SkillQ (skillq.net - Squizz Caphinator)';
const localhost = window.location.hostname === 'localhost';
const ssoLocalClientId = 'a4a7c16cc97440afb765f8fee441ef5a';
const ssoPublicClientId = 'd614c2c75a9e4e509219f2c10f546fc3';

if (window.location.hostname === '127.0.0.1') {
	window.location = 'http://localhost:' + window.location.port + window.location.pathname + window.location.search + window.location.hash;
} else {
	(() => {
		try {
			const callbackUrl =
				window.location.protocol +
				'//' +
				window.location.hostname +
				(window.location.port === '' ? '' : ':' + window.location.port) +
				'/auth';
			console.log('Initializing ESI with callback URL:', callbackUrl);

			window.esi = new SimpleESI({
				appName: APP_NAME,
				clientID: localhost ? ssoLocalClientId : ssoPublicClientId,
				loginURL: '/login',
				authURL: '/auth',
				logoutURL: '/logout',
				callbackUrl,
				scopes: [
					"publicData",
					"esi-skills.read_skills.v1",
					"esi-skills.read_skillqueue.v1",
					"esi-wallet.read_character_wallet.v1",
					"esi-clones.read_clones.v1",
					"esi-clones.read_implants.v1"
				]
			});
			console.log('ESI initialized');
		} catch (e) {
			console.log(e);
		}
	})();
}