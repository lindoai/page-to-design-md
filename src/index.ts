import { Hono } from 'hono';
import { cors } from 'hono/cors';
import puppeteer from '@cloudflare/puppeteer';
import { readTurnstileTokenFromUrl, verifyTurnstileToken } from '../../_shared/turnstile';
import { renderTextToolPage, turnstileSiteKeyFromEnv } from '../../_shared/tool-page';

type Env = {
  Bindings: {
    BROWSER?: Fetcher;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
  };
};

const app = new Hono<Env>();
app.use('/api/*', cors());

app.get('/', (c) =>
  c.html(
    renderTextToolPage({
      title: 'Page to DESIGN.md',
      description: 'Extract a full design system snapshot from any live page using computed styles.',
      endpoint: '/api/design',
      sample: '{ "url": "https://example.com", "markdown": "# DESIGN.md\\n..." }',
      siteKey: turnstileSiteKeyFromEnv(c.env),
      buttonLabel: 'Extract',
      toolSlug: 'page-to-design-md',
      formatOptions: [
        { value: 'json', label: 'JSON' },
        { value: 'markdown', label: 'Markdown' },
      ],
    })
  )
);

app.get('/health', (c) => c.json({ ok: true }));

app.get('/api/design', async (c) => {
  const captcha = await verifyTurnstileToken(c.env, readTurnstileTokenFromUrl(c.req.url), c.req.header('CF-Connecting-IP'));
  if (!captcha.ok) return c.json({ error: captcha.error }, 403);

  const normalized = normalizeUrl(c.req.query('url') ?? '');
  const format = (c.req.query('format') ?? 'json').toLowerCase();
  if (!normalized) return c.json({ error: 'A valid http(s) URL is required.' }, 400);

  if (!c.env.BROWSER) {
    return c.json({ error: 'Browser Rendering is not available.' }, 503);
  }

  const report = await extractDesignSystem(c.env.BROWSER, normalized);
  if (!report) return c.json({ error: 'Failed to load page or extract design data.' }, 502);

  if (format === 'markdown') {
    return new Response(report.markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  }
  return c.json(report);
});

async function extractDesignSystem(browserBinding: Fetcher, url: string) {
  let browser: any;
  try {
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Extract everything from the rendered page
    const data = await page.evaluate(() => {
      const allElements = document.querySelectorAll('body *');
      const colors = new Set<string>();
      const bgColors = new Set<string>();
      const fontFamilies = new Set<string>();
      const fontSizes = new Set<string>();
      const fontWeights = new Set<string>();
      const lineHeights = new Set<string>();
      const letterSpacings = new Set<string>();
      const borderRadii = new Set<string>();
      const shadows = new Set<string>();
      const spacings = new Set<string>();
      const borderWidths = new Set<string>();
      const borderColors = new Set<string>();
      const zIndices = new Set<string>();
      const transitions = new Set<string>();
      const opacities = new Set<string>();

      for (const el of allElements) {
        const cs = window.getComputedStyle(el);

        // Colors
        const color = cs.color;
        const bg = cs.backgroundColor;
        if (color && color !== 'rgba(0, 0, 0, 0)') colors.add(color);
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') bgColors.add(bg);

        // Typography
        const ff = cs.fontFamily;
        if (ff) fontFamilies.add(ff.split(',')[0].trim().replace(/['"]/g, ''));
        const fs = cs.fontSize;
        if (fs && fs !== '0px') fontSizes.add(fs);
        const fw = cs.fontWeight;
        if (fw && fw !== '400') fontWeights.add(fw);
        const lh = cs.lineHeight;
        if (lh && lh !== 'normal') lineHeights.add(lh);
        const ls = cs.letterSpacing;
        if (ls && ls !== 'normal' && ls !== '0px') letterSpacings.add(ls);

        // Border radius
        const br = cs.borderRadius;
        if (br && br !== '0px') borderRadii.add(br);

        // Shadows
        const bs = cs.boxShadow;
        if (bs && bs !== 'none') shadows.add(bs);

        // Spacing (margin + padding)
        const mt = cs.marginTop, mr = cs.marginRight, mb = cs.marginBottom, ml = cs.marginLeft;
        const pt = cs.paddingTop, pr = cs.paddingRight, pb = cs.paddingBottom, pl = cs.paddingLeft;
        for (const s of [mt, mr, mb, ml, pt, pr, pb, pl]) {
          if (s && s !== '0px' && s !== 'auto') spacings.add(s);
        }

        // Borders
        const bw = cs.borderWidth;
        if (bw && bw !== '0px') borderWidths.add(bw);
        const bc = cs.borderColor;
        if (bc && bc !== 'rgba(0, 0, 0, 0)' && bc !== 'rgb(0, 0, 0)') borderColors.add(bc);

        // Z-index
        const zi = cs.zIndex;
        if (zi && zi !== 'auto' && zi !== '0') zIndices.add(zi);

        // Transitions
        const tr = cs.transition;
        if (tr && tr !== 'all 0s ease 0s' && tr !== 'none') transitions.add(tr);

        // Opacity
        const op = cs.opacity;
        if (op && op !== '1') opacities.add(op);
      }

      // CSS custom properties from :root
      const cssVars: Record<string, string> = {};
      try {
        const rootStyles = window.getComputedStyle(document.documentElement);
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of (sheet as CSSStyleSheet).cssRules) {
              if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === 'html')) {
                for (let i = 0; i < rule.style.length; i++) {
                  const prop = rule.style[i];
                  if (prop.startsWith('--')) {
                    cssVars[prop] = rule.style.getPropertyValue(prop).trim();
                  }
                }
              }
            }
          } catch {}
        }
      } catch {}

      // Headings
      const headings: Array<{ tag: string; text: string; fontSize: string; fontWeight: string; color: string }> = [];
      for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        document.querySelectorAll(tag).forEach((el) => {
          const cs = window.getComputedStyle(el);
          headings.push({
            tag: tag.toUpperCase(),
            text: (el.textContent || '').trim().slice(0, 80),
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            color: cs.color,
          });
        });
      }

      // Buttons
      const buttons: Array<{ text: string; bg: string; color: string; borderRadius: string; padding: string; fontSize: string }> = [];
      document.querySelectorAll('button, a[class*="btn"], a[class*="button"], [role="button"]').forEach((el) => {
        const cs = window.getComputedStyle(el);
        const text = (el.textContent || '').trim().slice(0, 50);
        if (text) {
          buttons.push({
            text,
            bg: cs.backgroundColor,
            color: cs.color,
            borderRadius: cs.borderRadius,
            padding: cs.padding,
            fontSize: cs.fontSize,
          });
        }
      });

      // Links
      const linkStyles: { color: string; textDecoration: string }[] = [];
      const links = document.querySelectorAll('a');
      const seen = new Set<string>();
      links.forEach((el) => {
        const cs = window.getComputedStyle(el);
        const key = `${cs.color}|${cs.textDecorationLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          linkStyles.push({ color: cs.color, textDecoration: cs.textDecorationLine });
        }
      });

      // Layout detection
      let flexCount = 0, gridCount = 0;
      allElements.forEach((el) => {
        const d = window.getComputedStyle(el).display;
        if (d === 'flex' || d === 'inline-flex') flexCount++;
        if (d === 'grid' || d === 'inline-grid') gridCount++;
      });

      // Media queries / breakpoints
      const breakpoints = new Set<string>();
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of (sheet as CSSStyleSheet).cssRules) {
            if (rule instanceof CSSMediaRule) {
              const match = rule.conditionText.match(/(\d+(?:\.\d+)?px)/g);
              if (match) match.forEach((m) => breakpoints.add(m));
            }
          }
        } catch {}
      }

      // @keyframes
      const animations = new Set<string>();
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of (sheet as CSSStyleSheet).cssRules) {
            if (rule instanceof CSSKeyframesRule) {
              animations.add(rule.name);
            }
          }
        } catch {}
      }

      // Framework detection
      const frameworks: string[] = [];
      const html = document.documentElement.outerHTML;
      if (html.includes('__next') || html.includes('_next/static')) frameworks.push('Next.js');
      if (html.includes('__nuxt')) frameworks.push('Nuxt');
      if (html.includes('data-reactroot') || html.includes('__react')) frameworks.push('React');
      if (html.includes('ng-') || html.includes('_ngcontent')) frameworks.push('Angular');
      if (html.includes('data-v-')) frameworks.push('Vue');
      if (html.includes('wp-content')) frameworks.push('WordPress');
      if (document.querySelector('[class*="tailwind"], [class*="tw-"]') || html.match(/class="[^"]*\b(flex|grid|gap-|px-|py-|text-|bg-|rounded-)/)) frameworks.push('Tailwind CSS');
      if (html.includes('bootstrap') || document.querySelector('.container .row .col')) frameworks.push('Bootstrap');

      // Google Fonts
      const googleFonts: string[] = [];
      document.querySelectorAll('link[href*="fonts.googleapis.com"]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        const match = href.match(/family=([^&]+)/);
        if (match) {
          match[1].split('|').forEach((f) => googleFonts.push(decodeURIComponent(f.split(':')[0]).replace(/\+/g, ' ')));
        }
      });

      return {
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        colors: [...colors].slice(0, 20),
        bgColors: [...bgColors].slice(0, 20),
        fontFamilies: [...fontFamilies].slice(0, 10),
        googleFonts,
        fontSizes: [...fontSizes].sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 15),
        fontWeights: [...fontWeights].sort(),
        lineHeights: [...lineHeights].slice(0, 10),
        letterSpacings: [...letterSpacings].slice(0, 8),
        borderRadii: [...borderRadii].slice(0, 10),
        shadows: [...shadows].slice(0, 8),
        spacings: [...spacings].sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 20),
        borderWidths: [...borderWidths].slice(0, 8),
        borderColors: [...borderColors].slice(0, 10),
        zIndices: [...zIndices].sort((a, b) => Number(a) - Number(b)),
        transitions: [...transitions].slice(0, 8),
        opacities: [...opacities],
        cssVars,
        headings: headings.slice(0, 20),
        buttons: buttons.slice(0, 8),
        linkStyles: linkStyles.slice(0, 5),
        layout: { flexCount, gridCount },
        breakpoints: [...breakpoints].sort((a, b) => parseFloat(a) - parseFloat(b)),
        animations: [...animations].slice(0, 10),
        frameworks,
      };
    });

    await browser.close();
    browser = null;

    // Build markdown
    const markdown = buildMarkdown(url, data);
    return { url, ...data, markdown };
  } catch {
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

function buildMarkdown(url: string, d: any): string {
  const md: string[] = [
    `# DESIGN.md`,
    '',
    `> Design system extraction for [${d.title || url}](${url})`,
    '',
    '---',
    '',
    `## Page Info`,
    `- **URL:** ${url}`,
    `- **Title:** ${d.title || '(none)'}`,
    `- **Description:** ${d.description || '(none)'}`,
    ...(d.frameworks.length ? [`- **Stack:** ${d.frameworks.join(', ')}`] : []),
    '',
  ];

  // Colors
  md.push(`## Color Palette`, '');
  if (d.colors.length) md.push(`**Text colors:**`, ...d.colors.slice(0, 10).map((c: string) => `- \`${c}\``), '');
  if (d.bgColors.length) md.push(`**Background colors:**`, ...d.bgColors.slice(0, 10).map((c: string) => `- \`${c}\``), '');

  // CSS Variables
  const varEntries = Object.entries(d.cssVars || {});
  if (varEntries.length) {
    md.push(`## CSS Custom Properties`, '');
    varEntries.slice(0, 30).forEach(([k, v]) => md.push(`- \`${k}\`: \`${v}\``));
    md.push('');
  }

  // Typography
  md.push(`## Typography`, '');
  const allFonts = [...new Set([...d.googleFonts, ...d.fontFamilies])];
  md.push(`**Font families:** ${allFonts.length ? allFonts.join(', ') : 'None detected'}`);
  md.push(`**Font sizes:** ${d.fontSizes.join(', ') || 'None'}`);
  md.push(`**Font weights:** ${d.fontWeights.join(', ') || 'None'}`);
  if (d.lineHeights.length) md.push(`**Line heights:** ${d.lineHeights.join(', ')}`);
  if (d.letterSpacings.length) md.push(`**Letter spacings:** ${d.letterSpacings.join(', ')}`);
  md.push('');

  // Headings
  if (d.headings.length) {
    md.push(`## Heading Hierarchy`, '');
    md.push(`| Level | Text | Size | Weight | Color |`, `|-------|------|------|--------|-------|`);
    d.headings.forEach((h: any) => md.push(`| ${h.tag} | ${h.text.slice(0, 40)} | ${h.fontSize} | ${h.fontWeight} | \`${h.color}\` |`));
    md.push('');
  }

  // Spacing
  if (d.spacings.length) {
    md.push(`## Spacing Scale`, '', `\`${d.spacings.join('` `')}\``, '');
  }

  // Border Radius
  if (d.borderRadii.length) {
    md.push(`## Border Radius`, '', ...d.borderRadii.map((r: string) => `- \`${r}\``), '');
  }

  // Shadows
  if (d.shadows.length) {
    md.push(`## Shadows & Elevation`, '', ...d.shadows.map((s: string) => `- \`${s}\``), '');
  }

  // Z-index
  if (d.zIndices.length) {
    md.push(`## Z-Index Layers`, '', `\`${d.zIndices.join('` `')}\``, '');
  }

  // Layout
  md.push(`## Layout`, '', `- **Flexbox containers:** ${d.layout.flexCount}`, `- **Grid containers:** ${d.layout.gridCount}`);
  if (d.breakpoints.length) md.push(`- **Breakpoints:** ${d.breakpoints.join(', ')}`);
  md.push('');

  // Motion
  if (d.transitions.length || d.animations.length) {
    md.push(`## Motion & Animation`, '');
    if (d.transitions.length) md.push(`**Transitions:**`, ...d.transitions.map((t: string) => `- \`${t}\``), '');
    if (d.animations.length) md.push(`**Keyframe animations:** ${d.animations.join(', ')}`, '');
  }

  // Buttons
  if (d.buttons.length) {
    md.push(`## Button Styles`, '');
    md.push(`| Text | Background | Color | Radius | Padding | Size |`, `|------|-----------|-------|--------|---------|------|`);
    d.buttons.forEach((b: any) => md.push(`| ${b.text.slice(0, 25)} | \`${b.bg}\` | \`${b.color}\` | ${b.borderRadius} | ${b.padding} | ${b.fontSize} |`));
    md.push('');
  }

  // Links
  if (d.linkStyles.length) {
    md.push(`## Link Styles`, '', ...d.linkStyles.map((l: any) => `- Color: \`${l.color}\`, Decoration: ${l.textDecoration}`), '');
  }

  // Borders
  if (d.borderWidths.length || d.borderColors.length) {
    md.push(`## Borders`, '');
    if (d.borderWidths.length) md.push(`**Widths:** ${d.borderWidths.join(', ')}`);
    if (d.borderColors.length) md.push(`**Colors:**`, ...d.borderColors.slice(0, 6).map((c: string) => `- \`${c}\``));
    md.push('');
  }

  // Opacity
  if (d.opacities.length) {
    md.push(`## Opacity Values`, '', `\`${d.opacities.join('` `')}\``, '');
  }

  return md.join('\n');
}

function normalizeUrl(value: string): string | null {
  try {
    const u = new URL(value.startsWith('http') ? value : `https://${value}`);
    return u.toString();
  } catch {
    return null;
  }
}

export default app;
