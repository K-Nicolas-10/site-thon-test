// The storefront's own suite (ADR 0001, D-20). It stands in for the edge proxy by setting
// window.__VARIANT__ before the page loads, and captures the session record by stubbing sendBeacon.
// The console's specs gate runs it behind the real edge, which injects its own window.__VARIANT__ in
// <head>; the stand-in is locked read-only so that later assignment is ignored and the test keeps control.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const INGEST_URL = 'http://ingest.test/api/ingest/ing_test';
const VIEWPORTS = [
    { width: 360, height: 780 },
    { width: 1440, height: 900 },
];
const SESSION_ID = '6f1c9a02-1111-4222-8333-444455556666';

function injected(config: object = {}) {
    return {
        session_id: SESSION_ID,
        variant_id: 'test-variant',
        decision_id: 'dec_test',
        config,
        features: [1, 0, 1],
    };
}

/** Sets window.__VARIANT__ (undefined for null) so that the edge's injected assignment cannot replace it. */
async function standInForEdge(page: Page, variant: object | null) {
    await page.addInitScript((value) => {
        Object.defineProperty(window, '__VARIANT__', {
            value: value ?? undefined,
            writable: false,
            configurable: false,
        });
    }, variant);
}

async function open(page: Page, variant: object | null = injected()) {
    await standInForEdge(page, variant);
    await page.addInitScript(() => {
        (window as any).__beacons = [];
        navigator.sendBeacon = (url, body) => {
            (window as any).__beacons.push({ url, body });
            return true;
        };
    });
    await page.route('**/api/config', (route) =>
        route.fulfill({ json: { ingest_url: INGEST_URL } }),
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Checkout' })).toBeEnabled();
}

async function endSession(page: Page) {
    return page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide'));
        return (window as any).__beacons.map((beacon: any) => ({
            url: beacon.url,
            record: JSON.parse(beacon.body),
        }));
    });
}

async function webhookFor(page: Page, orderId: string | null) {
    const mock = process.env.PAYMENT_MOCK_URL ?? 'http://payment-mock:4010';
    const calls = await (await page.request.get(`${mock}/calls`)).json();
    return calls.find(
        (call: any) => call.kind === 'webhook' && call.order_id === orderId,
    );
}

async function noHorizontalOverflow(page: Page) {
    const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
}

for (const viewport of VIEWPORTS) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport });

        test('the landing Checkout reaches a webhook-confirmed order', async ({
            page,
        }) => {
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await open(page);
            await noHorizontalOverflow(page);

            await page.getByRole('button', { name: 'Checkout' }).click();
            const confirmation = page.getByTestId('confirmation');
            await expect(confirmation).toBeVisible();

            const orderId = await confirmation.getAttribute('data-order-id');
            await expect
                .poll(async () => (await webhookFor(page, orderId))?.status)
                .toBe(200);
            await noHorizontalOverflow(page);
            expect(errors).toEqual([]);
        });

        test('the bag flow goes through the shipping selector', async ({
            page,
        }) => {
            await open(page);
            await page.getByRole('button', { name: /^Skip/ }).click();
            await page.getByRole('button', { name: 'Quick add' }).first().click();
            await expect(page.getByRole('button', { name: 'Bag (1)' })).toBeVisible();
            await page.getByRole('button', { name: 'Bag (1)' }).click();

            const placeOrder = page.getByRole('button', { name: 'Place order' });
            await expect(placeOrder).toBeDisabled();
            await noHorizontalOverflow(page);

            await page.fill('[name=shipping_country]', 'Romania');
            await page.getByRole('button', { name: 'Next' }).click();
            await page.fill('[name=shipping_zip]', '010101');
            await page.getByRole('button', { name: 'Next' }).click();
            await page.getByRole('button', { name: 'Save shipping' }).click();

            await placeOrder.click();
            await expect(page.getByTestId('confirmation')).toBeVisible();

            const [{ record }] = await endSession(page);
            expect(record.telemetry.funnel_reached).toEqual([
                'landing',
                'cart',
                'shipping',
                'payment',
                'confirmation',
            ]);
            expect(record.telemetry.field_dwell_ms).toHaveProperty('shipping_zip');
        });
    });
}

const INLINE_SHIPPING = injected({
    cohorts: [
        {
            match: { viewport_bucket: '<400' },
            slots: { shipping: 'InlineShippingForm' },
        },
    ],
});

async function openBag(page: Page) {
    await page.getByRole('button', { name: /^Skip/ }).click();
    await page.getByRole('button', { name: 'Quick add' }).first().click();
    await page.getByRole('button', { name: 'Bag (1)' }).click();
}

test.describe('inline shipping', () => {
    test.describe('below 400px', () => {
        test.use({ viewport: VIEWPORTS[0] });

        test('saves country, postcode and method on one screen', async ({ page }) => {
            await open(page, INLINE_SHIPPING);
            await openBag(page);

            const form = page.locator('[data-component=InlineShippingForm]');
            await expect(form).toBeVisible();
            // Every field is on screen at once, with no step-by-step paging.
            await expect(form.locator('[name=shipping_country]')).toBeVisible();
            await expect(form.locator('[name=shipping_zip]')).toBeVisible();
            await expect(form.locator('[name=shipping_method]')).toBeVisible();
            await noHorizontalOverflow(page);

            const placeOrder = page.getByRole('button', { name: 'Place order' });
            await expect(placeOrder).toBeDisabled();

            await page.fill('[name=shipping_country]', 'Romania');
            await page.fill('[name=shipping_zip]', '010101');
            await page.selectOption('[name=shipping_method]', 'Express (1-2 days)');
            await page.getByRole('button', { name: 'Save shipping' }).click();

            await placeOrder.click();
            await expect(page.getByTestId('confirmation')).toBeVisible();
        });
    });

    test.describe('at 400px and wider', () => {
        test.use({ viewport: VIEWPORTS[1] });

        test('the cohort does not match, so the step-by-step selector stays', async ({ page }) => {
            await open(page, INLINE_SHIPPING);
            await openBag(page);

            await expect(page.locator('[data-component=MultiStepShippingSelector]')).toBeVisible();
            await expect(page.locator('[data-component=InlineShippingForm]')).toHaveCount(0);
        });
    });
});

test.describe('variant config', () => {
    test('with no config the baseline renders', async ({ page }) => {
        await open(page);
        await expect(
            page.locator('[data-component=Hero_Apple_Ecosystem]'),
        ).toBeVisible();
    });

    test('a cohort that does not match leaves the baseline', async ({ page }) => {
        await open(
            page,
            injected({
                cohorts: [
                    {
                        match: { os: 'Android' },
                        slots: { hero: 'Hero_Android_Ecosystem' },
                    },
                ],
            }),
        );
        await expect(
            page.locator('[data-component=Hero_Apple_Ecosystem]'),
        ).toBeVisible();
    });

    test('the catalog filter narrows the catalog', async ({ page }) => {
        await open(
            page,
            injected({
                cohorts: [
                    {
                        match: {},
                        slots: {},
                        catalog_filter: { category: 'headwear' },
                    },
                ],
            }),
        );
        await page.getByRole('button', { name: /^Skip/ }).click();
        await expect(page.getByRole('heading', { name: '3 items match' })).toBeVisible();
    });

    test('a component missing from the registry fails loudly', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await standInForEdge(
            page,
            injected({ cohorts: [{ match: {}, slots: { hero: 'Hero_Does_Not_Exist' } }] }),
        );
        await page.goto('/');
        await expect.poll(() => errors.join()).toContain('Hero_Does_Not_Exist');
    });

    test.describe('on Android', () => {
        test.use({ userAgent: ANDROID_UA });

        test('the matching cohort swaps the hero', async ({ page }) => {
            await open(
                page,
                injected({
                    cohorts: [
                        {
                            match: { os: 'Android' },
                            slots: { hero: 'Hero_Android_Ecosystem' },
                        },
                    ],
                }),
            );
            await expect(
                page.locator('[data-component=Hero_Android_Ecosystem]'),
            ).toBeVisible();
            // The other slots keep the baseline's components.
            await expect(page.locator('[data-component=GuidedFinder]')).toBeVisible();
        });

        test('a bounce is attributed to the hero', async ({ page }) => {
            await open(page);
            const [{ url, record }] = await endSession(page);

            expect(url).toBe(INGEST_URL);
            // Never scrolled, on a page taller than the viewport.
            expect(record.telemetry.scroll_depth).toBeGreaterThan(0);
            expect(record.telemetry.scroll_depth).toBeLessThan(1);
            expect(record).toMatchObject({
                type: 'session_end',
                session_id: SESSION_ID,
                variant_id: 'test-variant',
                decision_id: 'dec_test',
                context: {
                    os: 'Android',
                    device: 'mobile',
                    features: [1, 0, 1],
                },
                manifest: { variant_id: 'test-variant' },
                telemetry: {
                    converted: false,
                    order_value: null,
                    exit_step: 'landing',
                    exit_component: 'Hero_Apple_Ecosystem',
                    funnel_reached: ['landing'],
                },
            });
            expect(record.manifest.components).toContainEqual({
                id: 'hero',
                component: 'Hero_Apple_Ecosystem',
                target_os: 'iOS',
                price_tier: 'premium',
                layout_density: 'medium',
            });
        });
    });
});

test.describe('session record', () => {
    test('rage clicks count against the component', async ({ page }) => {
        await open(page);
        // Dispatched in one tick: real clicks can take longer than the rage window on a slow runner.
        await page.evaluate(() => {
            const heading = document.querySelector(
                '[data-component=ExpressCheckout] h2',
            )!;
            for (let i = 0; i < 4; i++) {
                heading.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        });

        const [{ record }] = await endSession(page);
        expect(record.telemetry.rage_clicks).toEqual([
            { component: 'ExpressCheckout', count: 4 },
        ]);
        expect(record.telemetry.exit_component).toBe('ExpressCheckout');
    });

    test('a purchase is a conversion with no exit', async ({ page }) => {
        await open(page);
        await page.getByRole('button', { name: 'Checkout' }).click();
        await expect(page.getByTestId('confirmation')).toBeVisible();

        const [{ record }] = await endSession(page);
        expect(record.telemetry.converted).toBe(true);
        expect(record.telemetry.order_value).toBeGreaterThan(0);
        expect(record.telemetry.exit_step).toBeNull();
        expect(record.telemetry.exit_component).toBeNull();
        expect(record.telemetry.funnel_reached).toContain('confirmation');
        // The order id on the element must not leak into the manifest as a tag.
        const confirmation = record.manifest.components.find(
            (c: any) => c.component === 'Confirmation',
        );
        expect(confirmation).toEqual({ id: 'Confirmation', component: 'Confirmation' });
    });

    test('the country comes from the proxy', async ({ page }) => {
        await open(page, { ...injected(), country: 'RO' });
        const [{ record }] = await endSession(page);
        expect(record.context.geo).toEqual({ country: 'RO' });
    });

    test('no country means no geo, so attribution leaves the session out of that segment', async ({
        page,
    }) => {
        await open(page);
        const [{ record }] = await endSession(page);
        expect(record.context).not.toHaveProperty('geo');
    });

    test('only one record is sent per page load', async ({ page }) => {
        await open(page);
        await endSession(page);
        expect(await endSession(page)).toHaveLength(1);
    });

    test('nothing is sent without an edge-minted session', async ({ page }) => {
        await open(page, null);
        expect(await endSession(page)).toEqual([]);
    });
});
