/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		csrf: {
			trustedOrigins: ['https://partner.example', '*']
		}
	}
};

export default config;
