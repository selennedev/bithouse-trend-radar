# Roblox Trend Radar · Bithouse Studio

Página que reúne dados de Roblox, mercado e internet, normaliza tudo em um **Trend Score (0–100)** e classifica os jogos em 🔥 HOT, 📈 RISING e 💎 EARLY, com uma análise de oportunidade no **Bit House Lab**.

## Como funciona o "tempo real"

O GitHub Pages só serve arquivos estáticos, e as APIs do Roblox bloqueiam chamadas direto do navegador (CORS). Por isso:

1. Um **GitHub Action** roda a cada 15 min, busca todas as fontes e grava `data/radar.json`.
2. A **página** relê esse arquivo a cada 60 s e se redesenha quando há coleta nova. O topo mostra há quantos minutos foi a última coleta.

## Publicar (5 passos)

1. Crie um repositório (ex.: `bithouse-trend-radar`) e suba **todo o conteúdo desta pasta**, incluindo `.github/`.
2. **Settings → Pages →** *Deploy from a branch* → `main` / `(root)`.
3. **Settings → Actions → General → Workflow permissions →** *Read and write permissions*.
4. **Actions → Atualizar Radar → Run workflow** para a primeira coleta (substitui os dados de demonstração).
5. Abra `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## Fontes

| Fonte | Como é lida | Status |
|---|---|---|
| Roblox Trending / Charts / Discovery | `apis.roblox.com/explore-api` | automático |
| Roblox Game Stats | `games.roblox.com` (CCU, votos, gênero, data) | automático |
| DevForum | Discourse `top.json` / `latest.json` | automático |
| Rolimon's | `api.rolimons.com/games/v1/gamelist` | automático |
| Google Trends | RSS "em alta" (BR e US; mude com a env `TRENDS_GEOS`) | automático |
| YouTube | YouTube Data API v3 | precisa do secret `YOUTUBE_API_KEY` (grátis) |
| RoVitals, BloxScout | sem API pública | card com link |
| X/Twitter, TikTok | sem API gratuita | card com link |

Se uma fonte falhar, o card dela fica vermelho com o motivo e as outras seguem funcionando. Se tudo falhar, o último `radar.json` bom é mantido.

## Trend Score

`score = 30% momentum + 25% popularidade + 20% qualidade + 25% buzz externo`

- **Momentum**: variação de jogadores vs ~1h atrás (histórico em `data/history.json`). Na primeira hora, usa a presença nas listas Trending/Discovery.
- **Popularidade**: jogadores simultâneos em escala logarítmica.
- **Qualidade**: % de aprovação (👍), com mínimo de 50 votos.
- **Buzz**: aparece no Google Trends, DevForum, YouTube ou Rolimon's.

Classes: **HOT** = score ≥ 62 e ≥ 20 mil jogando · **EARLY** = novo (≤ 90 dias ou em Discovery), < 20 mil, momentum e qualidade altos · **RISING** = momentum ≥ 62 e ≥ 1 mil jogando. Todos os limites ficam em `scripts/update-data.mjs` (função `buildGames`).

## Rodar local

```bash
node scripts/update-data.mjs          # coleta real (Node 20+)
node scripts/update-data.mjs --demo   # dados fictícios para ver o layout
npx serve .                           # abre a página
```

## Observações

- O Action faz um commit a cada coleta. Para menos ruído, mude o cron para `*/30` ou `0 * * * *`.
- Os endpoints não oficiais (Explore API, Rolimon's, RSS do Google) podem mudar sem aviso; o status de cada card avisa quando isso acontecer.
