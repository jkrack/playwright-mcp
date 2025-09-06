import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { launch } from '@cloudflare/playwright';
import { createMcpAgent } from '@cloudflare/playwright-mcp';

// Create the base agent class from the library
const Base: any = createMcpAgent(env.BROWSER);

// Extend and register our custom tool during init(), ensuring it exists before tools are listed
export class PlaywrightMCP extends Base {
  async init() {
    try {
      const server = await (this as any).server; // promise resolved in base class
      if (server && typeof server.tool === 'function' && !(server as any).__triflow_registered) {
        (server as any).__triflow_registered = true;
        server.tool(
          'triflow.smoketest',
          z.object({
            baseUrl: z.string().url().default('https://triflow.ai'),
            email: z.string().email(),
            password: z.string().min(1)
          }),
          async ({ baseUrl, email, password }) => {
            const browser = await launch(env.BROWSER);
            const steps: string[] = [];
            const step = (s: string) => steps.push(s);
            try {
              const page = await browser.newPage();

              step('Open login');
              await page.goto(`${baseUrl}/login`, { waitUntil: 'load' });
              await page.waitForSelector('#email', { timeout: 20000 });
              await page.locator('#email').fill(email);
              await page.locator('#password').fill(password);
              step('Submit login');
              await page.locator('button[type="submit"]').click();
              await page.waitForURL(/\/dashboard(\/|$)/, { timeout: 30000 }).catch(async () => {
                await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'load' });
              });
              step('Login complete');

              step('Open new opportunity page');
              await page.goto(`${baseUrl}/dashboard/new-opportunity`, { waitUntil: 'load' });
              await page.waitForSelector('input[name="name"]', { timeout: 20000 });
              const stamp = Math.random().toString(36).slice(2, 8);
              await page.locator('input[name="name"]').fill(`E2E MCP Opportunity ${stamp}`);
              await page.locator('textarea[name="problem_statement"]').fill(
                'Users struggle to complete key flows on mobile during peak hours; drop-offs increased 18% QoQ. E2E test.'
              );

              step('Submit analyze with intelligence');
              await page.locator('button[type="submit"]').click();
              await page.waitForURL(/\/dashboard\/new-opportunity\/analysis/, { timeout: 60000 }).catch(() => null);
              const finalUrl = page.url();
              if (!finalUrl.includes('/dashboard/new-opportunity/analysis')) {
                const shot = await page.screenshot({ fullPage: true, type: 'png' });
                return {
                  content: [
                    { type: 'text', text: JSON.stringify({ ok: false, steps, error: `Did not reach analysis page: ${finalUrl}` }) },
                    { type: 'image', data: shot, mimeType: 'image/png' }
                  ]
                };
              }
              step('Reached analysis page');
              const urlObj = new URL(finalUrl);
              const opportunityId = urlObj.searchParams.get('opportunityId') || '';
              if (!opportunityId) {
                const shot = await page.screenshot({ fullPage: true, type: 'png' });
                return {
                  content: [
                    { type: 'text', text: JSON.stringify({ ok: false, steps, error: 'Missing opportunityId' }) },
                    { type: 'image', data: shot, mimeType: 'image/png' }
                  ]
                };
              }

              const hypothesesUrl = `${baseUrl}/dashboard/new-opportunity/analysis/hypotheses?opportunityId=${encodeURIComponent(opportunityId)}`;
              step('Open hypotheses page');
              await page.goto(hypothesesUrl, { waitUntil: 'load' });

              const addFirst = page.getByRole('button', { name: 'Add First Hypothesis' });
              const addHyp = page.getByRole('button', { name: 'Add Hypothesis' });
              if (await addFirst.isVisible().catch(() => false)) {
                step('Click Add First Hypothesis');
                await addFirst.click();
                await page.waitForResponse((res) => res.url().includes('/api/opportunities/') && res.request().method() === 'POST', { timeout: 60000 }).catch(() => null);
                await page.reload({ waitUntil: 'load' }).catch(() => null);
              } else if (await addHyp.isVisible().catch(() => false)) {
                step('Click Add Hypothesis');
                await addHyp.click();
                await page.waitForResponse((res) => res.url().includes('/api/opportunities/') && res.request().method() === 'POST', { timeout: 60000 }).catch(() => null);
                await page.reload({ waitUntil: 'load' }).catch(() => null);
              } else {
                step('No add button found; checking existing hypotheses');
              }

              step('Verify hypotheses visible');
              const rows = await page.locator('table tbody tr').count();
              const cards = await page.getByRole('heading', { name: /Hypothesis/i }).count();
              const ok = rows > 0 || cards > 0;
              const shot = await page.screenshot({ fullPage: true, type: 'png' });
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ ok, steps, opportunityId }) },
                  { type: 'image', data: shot, mimeType: 'image/png' }
                ]
              };
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err }) }] };
            } finally {
              try { await browser.close(); } catch {}
            }
          }
        );
      }
    } catch (e) {
      // swallow tool registration failures to not break the server
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname }  = new URL(request.url);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        return PlaywrightMCP.serve('/mcp').fetch(request, env, ctx);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
