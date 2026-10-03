const key = '__FAKE_STRIPE__';

export function GET() {
	return new Response(key.length.toString());
}
