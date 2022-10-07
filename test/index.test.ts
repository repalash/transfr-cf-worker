import worker, {Env} from '../src/index';
import { indexHTML } from "../src/indexHtml";

test('GET /', async () => {
	const req = new Request('http://test', { method: 'GET' });
	// @ts-ignore
	const env = getMiniflareBindings()
	// @ts-ignore
	const ctx = new ExecutionContext()
	const result = await worker.fetch(req, env, ctx);
	expect(result.status).toBe(200);

	const text = await result.text();
	expect(text).toBe(indexHTML);
});

async function testPutThenGet(data: string) {
	const req = new Request("http://localhost:8787/file.txt", { method: "PUT", body: data });
	// @ts-ignore
	const env = getMiniflareBindings();
	// @ts-ignore
	let ctx = new ExecutionContext();
	const result = await worker.fetch(req, env, ctx);
	expect(result.status).toBe(200);

	const text = await result.text();
	expect(text).toMatch(/http:\/\/localhost:8787\/[a-f0-9]{4}-[a-f0-9]{8}\/file.txt/);

	// @ts-ignore
	const waitUntils = await getMiniflareWaitUntil(ctx);
	expect(waitUntils.length).toBe(1);

	const req2 = new Request(text, { method: "GET" });
	// @ts-ignore
	ctx = new ExecutionContext();
	const result2 = await worker.fetch(req2, env, ctx);
	expect(result2.status).toBe(200);
	const text2 = await result2.text();
	expect(text2).toBe(data);
}

test('PUT /file.txt then GET file.txt', async () => {
	const data = "Hello, world!";
	await testPutThenGet(data);

});

test('PUT /file.txt large file', async () => {
	// @ts-ignore
	const env = getMiniflareBindings() as Env
	let data = "1".repeat(parseInt(env.KV_MAX_FILE_SIZE_BYTES) - 100);

	await testPutThenGet(data);

	data = "1".repeat(parseInt(env.KV_MAX_FILE_SIZE_BYTES) + 1);

	const req = new Request("http://localhost:8787/file.txt", { method: "PUT", body: data });
	// @ts-ignore
	let ctx = new ExecutionContext();
	const result = await worker.fetch(req, env, ctx);
	expect(result.status).toBe(400);
	const text = await result.text()
	expect(text).toMatch(/^Invalid file size/);

});
