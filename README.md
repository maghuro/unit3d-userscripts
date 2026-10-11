**Gist oficial:** https://gist.github.com/maghuro/da2dbfec94951990cbc54e75a9aee318

# DarkPeers BONanza Giveaway

Userscript para organizar giveaways de BON no DarkPeers, com limite máximo de **45 minutos**, participação no BON Pool e modos Silent e Rehearsal.

## Instalação

1. Instala um gestor de userscripts, como o **Tampermonkey**.
2. Abre o [userscript no Gist](https://gist.githubusercontent.com/maghuro/da2dbfec94951990cbc54e75a9aee318/raw/DarkPeers_BONanza_Giveaway.user.js) e confirma a instalação.
3. Acede a [darkpeers.org](https://darkpeers.org/) para o utilizar.

**Links úteis:**
- [Gist oficial](https://gist.github.com/maghuro/da2dbfec94951990cbc54e75a9aee318)
- [Instalar / atualizar (.user.js)](https://gist.githubusercontent.com/maghuro/da2dbfec94951990cbc54e75a9aee318/raw/DarkPeers_BONanza_Giveaway.user.js)
- [Metadados de atualização automática (.meta.js)](https://gist.githubusercontent.com/maghuro/da2dbfec94951990cbc54e75a9aee318/raw/DarkPeers_BONanza_Giveaway.meta.js)

## Código e publicação

O código-fonte está dividido em 15 ficheiros em [`userscripts/giveaway/src/`](userscripts/giveaway/src/). O ficheiro `.user.js` é gerado automaticamente. Para validar:

```bash
node scripts/build-bonanza.mjs --check
node --test tests/bonanza-*.test.mjs
```

Quando há alterações relevantes na branch `main`, o GitHub Actions publica automaticamente o userscript e os metadados no mesmo Gist. **Não é necessário atualizar o Gist manualmente.**
