# TREE

**Traces • Reflection • Evidence • Experience**
Pedagogical Documentation Studio for Fulton Community School & Farm

TREE turns classroom observations and photos into documentation slides for Reggio-inspired walls, with suggested DRDP (2025) measures for educator review.

## What is in this repository

- `index.html` is the TREE web page, published with GitHub Pages.
- `index.js` is the TREE server that runs on Render. It holds the Anthropic API key, checks the school passcode, and sends each analysis request to the AI model.

## How it runs

- Web page at https://renee-creator.github.io/fulton_proxy/index.html
- Server at https://fulton-proxy.onrender.com, which shows a status page when opened in a browser
- Server settings on Render are `ANTHROPIC_API_KEY` and `SCHOOL_PASSCODES`

The repository and server keep the fulton_proxy name so saved links and Home Screen icons keep working.

## Privacy

Photos and notes are sent to Anthropic's AI only for the analysis. TREE does not store them. Anthropic deletes them within 30 days and does not use them to train its AI. The AI's levels are suggestions for educator review and are not a formal DRDP rating.
