# AI food-macro estimator — deploy steps

This is a small Cloudflare Worker that holds your Anthropic API key server-side
and proxies requests from the Gym Tracker app. The key never touches the
public site's code — only this Worker (and Cloudflare's secret store) sees it.

## 1. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up / sign in.
2. Left sidebar → **API Keys** → **Create Key**. Copy it (starts with `sk-ant-`).
3. Anthropic's API is pay-per-use. New accounts usually get some free trial
   credit; sustained use beyond that needs a payment method on the Anthropic
   account (separate from anything Cloudflare-related below).

## 2. Deploy the Worker (free, no credit card required)

In Terminal:

```bash
cd /Users/rohannair/Vibecode-App/worker

# Log into Cloudflare — opens a browser, creates a free account if you don't have one
npx wrangler login

# Store your Anthropic key as a Worker secret — pasted directly into Cloudflare,
# never sent to me or committed to the repo
npx wrangler secret put ANTHROPIC_API_KEY
# (paste the sk-ant-... key when prompted, press Enter)

# Deploy
npx wrangler deploy
```

That last command prints a URL that looks like:

```
https://gym-tracker-ai.<your-subdomain>.workers.dev
```

## 3. Wire it up

Send me that URL — I'll drop it into `ai-config.js` and enable the
"Estimate with AI" / "Scan photo" buttons in the Weight tab's food log. That's
the only remaining step; the client-side code that calls this Worker is
already written and just waiting for the endpoint.

## What it costs

- **Cloudflare Workers**: free tier covers 100,000 requests/day — nowhere
  close to what personal use would hit. No card required for the free tier.
- **Anthropic API**: charged per request based on tokens used. A single food
  estimate (short text or one photo) costs a small fraction of a cent with
  the `claude-haiku-4-5` model this Worker uses. Real cost, but very low for
  personal use — check [anthropic.com/pricing](https://www.anthropic.com/pricing) for current rates.
