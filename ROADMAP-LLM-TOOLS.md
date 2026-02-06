# Roadmap: Ferramentas de Contexto para LLMs em Frontend Svelte

> Documento de especificação para ferramentas que melhoram o contexto disponível para LLMs ao trabalhar com aplicações Svelte.

## Sumário Executivo

### O Problema

LLMs enfrentam limitações significativas ao ajudar desenvolvedores frontend:

1. **Cegueira Visual**: Não "veem" o resultado renderizado
2. **Estado Invisível**: Não conhecem valores atuais de variáveis/stores
3. **CSS Opaco**: Não sabem o estilo final após cascading
4. **Fluxo de Dados Obscuro**: Difícil rastrear origem de props
5. **Erros Ocultos**: Não têm acesso ao console do navegador
6. **Performance Invisível**: Não detectam re-renders desnecessários
7. **A11y Implícita**: Problemas de acessibilidade não são óbvios no código

### A Solução

Uma suíte de ferramentas de desenvolvimento que capturam e formatam contexto relevante para LLMs, permitindo diagnósticos mais precisos e soluções mais efetivas.

---

## Ferramenta 1: Svelte-State-Grab

### Descrição

Captura o estado atual de um componente (props, variáveis $state, stores conectados) e formata de maneira estruturada para consumo por LLMs.

### Problema que Resolve

Quando um desenvolvedor diz "o componente não está funcionando", o LLM não sabe:
- Quais props o componente está recebendo
- Valores atuais das variáveis reativas
- Estado dos stores conectados
- Se os dados são `undefined`, `null`, ou valores inesperados

### Output Exemplo

```
=== Estado do Componente: ProductCard ===

📥 PROPS RECEBIDAS:
  product: { id: 123, name: "Widget", price: null, inStock: true }
  onAddToCart: [Function]
  quantity: 0

🔄 ESTADO INTERNO ($state):
  isHovered: false
  selectedVariant: undefined
  localQuantity: 0

🏪 STORES CONECTADOS:
  $cartStore: { items: [], total: 0 }
  $userStore: { isLoggedIn: true, id: "user_456" }

⚡ VALORES DERIVADOS ($derived):
  formattedPrice: "R$ --" (price é null)
  canAddToCart: false (quantity === 0)

📍 Localização: src/lib/components/ProductCard.svelte:1
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                    Svelte-State-Grab                     │
├─────────────────────────────────────────────────────────┤
│  1. Intercepta clique com modifier (Alt+Shift+Click)    │
│                         ↓                                │
│  2. Encontra elemento com __svelte_meta                 │
│                         ↓                                │
│  3. Acessa contexto do componente via Svelte internals  │
│     - $$props (props recebidas)                         │
│     - $$state (estado interno)                          │
│     - Contexto de stores via getContext                 │
│                         ↓                                │
│  4. Serializa valores (handling circular refs)          │
│                         ↓                                │
│  5. Formata output otimizado para LLM                   │
│                         ↓                                │
│  6. Copia para clipboard / exibe popup                  │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| Acesso a props | ✅ Viável | Svelte 5 expõe via `$props()` |
| Acesso a $state | ⚠️ Parcial | Requer introspecção de signals |
| Acesso a stores | ⚠️ Parcial | Stores globais OK, contextuais difícil |
| Serialização | ✅ Viável | JSON.stringify com replacer custom |
| Circular refs | ✅ Viável | Bibliotecas existentes (flatted) |

**Desafios Técnicos:**
1. Svelte 5 não expõe estado interno diretamente como Svelte 4
2. Signals são privados por design
3. Stores contextuais requerem conhecer as keys

**Soluções Possíveis:**
1. Wrapper `$inspectable()` que o dev adiciona para expor estado
2. Babel/Vite plugin que instrumenta componentes em dev
3. Usar Svelte DevTools protocol (se disponível)

### Plano de Implementação

#### Fase 1: MVP (1-2 semanas)
- [ ] Captura de props via `$$props` ou reflection
- [ ] Serialização básica com handling de funções e circular refs
- [ ] UI similar ao SvelteGrab
- [ ] Formatação texto para clipboard

#### Fase 2: Estado Interno (2-3 semanas)
- [ ] Pesquisar APIs internas do Svelte 5 para signals
- [ ] Implementar wrapper `$inspectable()` como alternativa
- [ ] Detectar e listar variáveis $state declaradas

#### Fase 3: Stores (1-2 semanas)
- [ ] Capturar stores globais (importados)
- [ ] Tentar detectar stores contextuais
- [ ] Mostrar valor atual e tipo do store

#### Fase 4: Polish (1 semana)
- [ ] Integração com SvelteGrab (mesmo popup, aba diferente)
- [ ] Diff de estado (antes/depois)
- [ ] Export como JSON estruturado

### Estimativa Total: 5-8 semanas

---

## Ferramenta 2: Svelte-Style-Grab

### Descrição

Captura os estilos computados de um elemento e identifica a origem de cada propriedade CSS (componente scoped, global, Tailwind, inline, etc.).

### Problema que Resolve

CSS cascading é complexo. Quando um desenvolvedor pergunta "por que este botão está vermelho?", o LLM precisa saber:
- Qual é o estilo final computado
- De onde cada propriedade vem
- Qual regra está "ganhando" (specificity)
- Se há conflitos ou overrides

### Output Exemplo

```
=== Estilos de: <button class="btn primary"> ===

📐 BOX MODEL:
  width: 120px (auto → computado)
  height: 40px
  padding: 8px 16px → src/lib/Button.svelte:89 (.btn)
  margin: 0 → user-agent default

🎨 VISUAL:
  background: #3b82f6 → Tailwind (bg-blue-500)
  color: #ffffff → src/lib/Button.svelte:92 (.btn.primary)
  border: none → src/lib/Button.svelte:90 (.btn)
  border-radius: 8px → app.css:45 (.btn) ⚠️ OVERRIDE por specificidade

📝 TYPOGRAPHY:
  font-size: 14px → Tailwind (text-sm)
  font-weight: 600 → src/lib/Button.svelte:95 (.btn)
  font-family: Inter, sans-serif → :root (global)

🔀 CONFLITOS DETECTADOS:
  ⚠️ border-radius: definido em 2 lugares
     - app.css:45 (.btn) → 4px [PERDEU - specificidade 0,1,0]
     - Button.svelte:91 (.btn) → 8px [GANHOU - specificidade 0,1,0 + scoped]

📍 Elemento: src/lib/Button.svelte:12
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                    Svelte-Style-Grab                     │
├─────────────────────────────────────────────────────────┤
│  1. Captura elemento alvo                               │
│                         ↓                                │
│  2. window.getComputedStyle(element)                    │
│     → Obtém todos os estilos finais                     │
│                         ↓                                │
│  3. document.styleSheets iteration                      │
│     → Encontra regras que matcham o elemento            │
│                         ↓                                │
│  4. Para cada propriedade:                              │
│     - Calcula specificity de cada regra                 │
│     - Identifica origem (arquivo:linha)                 │
│     - Detecta se há conflito                            │
│                         ↓                                │
│  5. Agrupa por categoria (box model, visual, etc.)      │
│                         ↓                                │
│  6. Formata e exporta                                   │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| Computed styles | ✅ Viável | API nativa do browser |
| Matching rules | ✅ Viável | CSSOM + element.matches() |
| Source maps | ⚠️ Parcial | Precisa de source maps CSS |
| Tailwind classes | ✅ Viável | Detectar por padrão de classe |
| Scoped styles | ⚠️ Parcial | Svelte adiciona hash, rastreável |
| Specificity calc | ✅ Viável | Algoritmo conhecido |

**Desafios Técnicos:**
1. Source maps de CSS nem sempre disponíveis
2. Tailwind JIT gera classes dinamicamente
3. CSS-in-JS é difícil de rastrear
4. Shadow DOM isola estilos

**Soluções Possíveis:**
1. Vite plugin que injeta metadados de origem no CSS
2. Heurísticas para identificar Tailwind (padrão de nomes)
3. Para scoped, usar o hash como identificador

### Plano de Implementação

#### Fase 1: Computed Styles (1 semana)
- [ ] Capturar getComputedStyle completo
- [ ] Agrupar por categorias semânticas
- [ ] UI de visualização

#### Fase 2: Rule Matching (2 semanas)
- [ ] Iterar styleSheets e encontrar matches
- [ ] Calcular specificity de cada regra
- [ ] Ordenar por "quem ganha"

#### Fase 3: Source Attribution (2-3 semanas)
- [ ] Detectar estilos scoped Svelte (por hash)
- [ ] Detectar classes Tailwind (por padrão)
- [ ] Usar source maps quando disponíveis
- [ ] Fallback: mostrar arquivo CSS sem linha

#### Fase 4: Conflict Detection (1 semana)
- [ ] Identificar propriedades definidas múltiplas vezes
- [ ] Explicar qual regra "ganhou" e por quê
- [ ] Sugerir fixes para conflitos

### Estimativa Total: 6-7 semanas

---

## Ferramenta 3: Svelte-Props-Tracer

### Descrição

Rastreia a cadeia completa de onde cada prop veio, desde o componente raiz até o componente atual, incluindo transformações intermediárias.

### Problema que Resolve

Em árvores de componentes profundas, é difícil saber:
- De onde uma prop originalmente veio
- Quais componentes intermediários a passaram
- Se houve transformações no caminho
- Por que a prop tem um valor inesperado

### Output Exemplo

```
=== Trace de Props: <UserAvatar> ===

🔍 PROP: user
  Valor atual: { name: "João", avatar: null }
  Tipo: Object

📍 CADEIA DE ORIGEM:

  [1] +page.svelte:15
      │ const user = await load() // { name: "João", avatar: "url..." }
      │ <UserProfile {user} />
      ↓
  [2] UserProfile.svelte:8
      │ let { user } = $props()
      │ const displayUser = { ...user, avatar: user.avatar || null }
      │                                        ^^^^^^^^^^^^^^^^
      │                                        ⚠️ TRANSFORMAÇÃO: avatar virou null
      │ <UserAvatar user={displayUser} />
      ↓
  [3] UserAvatar.svelte:3 ← VOCÊ ESTÁ AQUI
      │ let { user } = $props()
      │ // user.avatar é null

💡 INSIGHT:
  O avatar era "url..." na origem mas foi transformado para null
  em UserProfile.svelte:9 pela expressão: user.avatar || null

  Isso acontece porque || trata string vazia como falsy.
  Sugestão: usar ?? ao invés de ||
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                   Svelte-Props-Tracer                    │
├─────────────────────────────────────────────────────────┤
│  COMPILAÇÃO (Vite Plugin):                              │
│  1. Instrumenta cada passagem de prop                   │
│  2. Adiciona metadata de origem                         │
│  3. Wrapa valores com Proxy para tracking               │
├─────────────────────────────────────────────────────────┤
│  RUNTIME:                                               │
│  1. Ao passar prop, registra no trace stack            │
│  2. Detecta transformações (valor mudou)               │
│  3. Mantém histórico por componente                    │
├─────────────────────────────────────────────────────────┤
│  CAPTURA (Click):                                       │
│  1. Acessa trace stack do componente                   │
│  2. Reconstrói cadeia de origem                        │
│  3. Identifica onde houve mudanças                     │
│  4. Formata para output                                │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| Tracking de props | ⚠️ Complexo | Requer instrumentação |
| Vite plugin | ✅ Viável | APIs bem documentadas |
| Svelte compiler hook | ⚠️ Parcial | Preprocessor limitado |
| Runtime overhead | ⚠️ Médio | Proxies têm custo |
| Source locations | ✅ Viável | AST do compiler tem info |

**Desafios Técnicos:**
1. Requer modificação do código em compile-time
2. Overhead de runtime pode ser significativo
3. Proxies não funcionam com todos os tipos
4. Spread props (`{...obj}`) difícil de rastrear

**Soluções Possíveis:**
1. Opt-in por componente (`<script trace>`)
2. Apenas em dev mode com flag
3. Sampling ao invés de tracking completo
4. Integração com Svelte DevTools

### Plano de Implementação

#### Fase 1: Proof of Concept (2 semanas)
- [ ] Vite plugin básico que instrumenta props
- [ ] Tracking simples de um nível
- [ ] Validar overhead de performance

#### Fase 2: Deep Tracking (3 semanas)
- [ ] Tracking multi-nível (árvore completa)
- [ ] Detectar transformações de valor
- [ ] Manter stack trace eficiente

#### Fase 3: Transformations (2 semanas)
- [ ] Identificar onde valores mudaram
- [ ] Mostrar expressão que causou mudança
- [ ] Sugerir fixes comuns (|| vs ??)

#### Fase 4: Integration (1 semana)
- [ ] UI de visualização da árvore
- [ ] Integração com SvelteGrab
- [ ] Export para LLM

### Estimativa Total: 8-10 semanas

---

## Ferramenta 4: Svelte-A11y-Reporter

### Descrição

Analisa um elemento e sua subárvore para identificar problemas de acessibilidade, com explicações claras e sugestões de correção.

### Problema que Resolve

Problemas de acessibilidade não são visíveis no código:
- Contraste insuficiente
- Falta de labels em inputs
- Ordem de foco incorreta
- Missing ARIA attributes
- Imagens sem alt text

### Output Exemplo

```
=== Relatório de Acessibilidade: <form class="login-form"> ===

🔴 CRÍTICO (3):

  1. Input sem label associado
     │ <input type="email" placeholder="Email">
     │ Linha: src/lib/LoginForm.svelte:15
     │
     │ ❌ Problema: Screen readers não conseguem identificar o campo
     │ ✅ Correção:
     │    <label for="email">Email</label>
     │    <input id="email" type="email">
     │
     │    Ou use aria-label:
     │    <input type="email" aria-label="Endereço de email">

  2. Botão sem texto acessível
     │ <button><svg>...</svg></button>
     │ Linha: src/lib/LoginForm.svelte:28
     │
     │ ❌ Problema: Botão lido como "botão" sem contexto
     │ ✅ Correção:
     │    <button aria-label="Enviar formulário">

  3. Contraste insuficiente
     │ <span class="helper-text">Mínimo 8 caracteres</span>
     │ Linha: src/lib/LoginForm.svelte:22
     │
     │ ❌ Problema: Ratio 2.8:1 (mínimo WCAG AA: 4.5:1)
     │    Foreground: #999999
     │    Background: #ffffff
     │ ✅ Correção: Usar cor mais escura, ex: #767676 (4.5:1)

🟡 AVISOS (2):

  1. Ordem de tab pode ser confusa
     │ tabindex="5" em elemento
     │ ⚠️ Usar tabindex positivo quebra ordem natural

  2. Formulário sem landmark
     │ <form> sem role ou aria-label
     │ ⚠️ Adicionar aria-label="Formulário de login"

🟢 BOM (4):
  ✓ Todos os inputs têm type definido
  ✓ Formulário tem botão submit
  ✓ Nenhum autofocus inesperado
  ✓ Linguagem da página definida

📊 SCORE: 65/100 (Precisa melhorar)
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                   Svelte-A11y-Reporter                   │
├─────────────────────────────────────────────────────────┤
│  1. Captura elemento e subárvore                        │
│                         ↓                                │
│  2. Executa bateria de testes:                          │
│     ├─ axe-core (biblioteca de a11y)                   │
│     ├─ Contrast checker (WCAG)                         │
│     ├─ ARIA validator                                  │
│     ├─ Focus order analyzer                            │
│     └─ Semantic HTML checker                           │
│                         ↓                                │
│  3. Correlaciona com source locations                   │
│     (usa __svelte_meta para mapear)                    │
│                         ↓                                │
│  4. Gera sugestões de correção                         │
│     (templates pré-definidos por tipo de erro)         │
│                         ↓                                │
│  5. Formata relatório                                  │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| axe-core integration | ✅ Viável | Biblioteca madura |
| Contrast calculation | ✅ Viável | Algoritmo WCAG |
| Source mapping | ✅ Viável | __svelte_meta |
| Fix suggestions | ✅ Viável | Templates |
| Real-time analysis | ⚠️ Parcial | axe-core é pesado |

**Desafios Técnicos:**
1. axe-core bundle é grande (~200kb)
2. Análise completa pode ser lenta
3. Alguns problemas requerem contexto humano
4. False positives são comuns

**Soluções Possíveis:**
1. Lazy load do axe-core
2. Cache de resultados
3. Análise incremental (só elemento clicado)
4. Whitelist de regras mais relevantes

### Plano de Implementação

#### Fase 1: Core Integration (2 semanas)
- [ ] Integrar axe-core
- [ ] Análise de elemento único
- [ ] Output básico de problemas

#### Fase 2: Source Mapping (1 semana)
- [ ] Mapear violations para source locations
- [ ] Usar __svelte_meta existente

#### Fase 3: Fix Suggestions (2 semanas)
- [ ] Templates de correção por tipo de erro
- [ ] Código sugerido copy-paste ready
- [ ] Explicações educativas

#### Fase 4: Contrast & Visual (1 semana)
- [ ] Checker de contraste standalone
- [ ] Visualização de problemas no DOM
- [ ] Color suggestions

#### Fase 5: Polish (1 semana)
- [ ] Score geral de a11y
- [ ] Integração com SvelteGrab
- [ ] Export formatado para LLM

### Estimativa Total: 7-8 semanas

---

## Ferramenta 5: Svelte-Error-Context

### Descrição

Coleta erros e warnings do console com contexto enriquecido, incluindo stack traces limpos, valores de variáveis no momento do erro, e correlação com código fonte.

### Problema que Resolve

LLMs não têm acesso ao console do navegador:
- Erros de runtime são invisíveis
- Stack traces são crípticos
- Não sabem o contexto do erro
- Warnings importantes passam despercebidos

### Output Exemplo

```
=== Erros Capturados (últimos 5min) ===

🔴 ERROR [14:32:15]

  TypeError: Cannot read properties of undefined (reading 'name')

  📍 LOCALIZAÇÃO:
     src/lib/UserCard.svelte:23

  📝 CÓDIGO:
     21 │ function displayName(user) {
     22 │   // user é undefined aqui
     23 │ → return user.name.toUpperCase()
     24 │ }

  🔍 CONTEXTO NO MOMENTO DO ERRO:
     user = undefined
     Chamado de: src/routes/+page.svelte:45
     Props do componente: { userId: "123", user: undefined }

  💡 CAUSA PROVÁVEL:
     A prop 'user' ainda não foi carregada (async) quando
     displayName() foi chamado.

  ✅ SUGESTÃO:
     Adicionar verificação: user?.name?.toUpperCase() ?? 'Unknown'
     Ou usar {#if user} antes de renderizar

───────────────────────────────────────

🟡 WARNING [14:32:10]

  [Svelte] <ProductList> received an unexpected slot "header"

  📍 src/routes/products/+page.svelte:12

  💡 O componente ProductList não define slot "header".
     Slots disponíveis: default, footer

───────────────────────────────────────

🟡 WARNING [14:31:55]

  [Svelte] Reactive statement has no reactive dependencies

  📍 src/lib/Counter.svelte:8

  📝 CÓDIGO:
     8 │ $: console.log('count changed') // Não usa 'count'

  💡 Este $: nunca vai re-executar.
     Corrija para: $: console.log('count:', count)
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                  Svelte-Error-Context                    │
├─────────────────────────────────────────────────────────┤
│  INTERCEPTAÇÃO:                                         │
│  1. Override console.error / console.warn               │
│  2. window.onerror handler                              │
│  3. window.onunhandledrejection                         │
├─────────────────────────────────────────────────────────┤
│  ENRIQUECIMENTO:                                        │
│  1. Parse stack trace                                   │
│  2. Map to source via sourcemaps                        │
│  3. Captura contexto (variáveis, props)                │
│  4. Detecta padrões comuns de erro                      │
├─────────────────────────────────────────────────────────┤
│  ARMAZENAMENTO:                                         │
│  1. Buffer circular (últimos N erros)                  │
│  2. Deduplicação (mesmo erro = incrementa count)       │
│  3. Timestamp e sessão                                  │
├─────────────────────────────────────────────────────────┤
│  OUTPUT:                                                │
│  1. Popup com lista de erros                           │
│  2. Export formatado para LLM                          │
│  3. Integração com SvelteGrab                          │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| Console intercept | ✅ Viável | APIs nativas |
| Stack parsing | ✅ Viável | Error.stack |
| Source maps | ✅ Viável | Já suportado em browsers |
| Contexto de vars | ⚠️ Parcial | Limitado sem instrumentação |
| Padrão detection | ✅ Viável | Regex + heurísticas |

**Desafios Técnicos:**
1. Capturar variáveis no momento do erro é difícil
2. Source maps nem sempre disponíveis
3. Erros em código de terceiros (libs)
4. Overhead de interceptação

**Soluções Possíveis:**
1. Para contexto, usar última snapshot conhecida
2. Fallback para stack trace original se sem sourcemap
3. Filtrar erros de node_modules
4. Throttling de erros repetidos

### Plano de Implementação

#### Fase 1: Intercept básico (1 semana)
- [ ] Override console.error/warn
- [ ] Capturar window.onerror
- [ ] Buffer circular de erros

#### Fase 2: Stack Parsing (1 semana)
- [ ] Parser de stack traces (Chrome, Firefox, Safari)
- [ ] Integração com source maps
- [ ] Mapear para arquivos Svelte

#### Fase 3: Contexto (2 semanas)
- [ ] Capturar props do componente no erro
- [ ] Detectar padrões comuns de erro
- [ ] Gerar sugestões de fix

#### Fase 4: UI & Export (1 semana)
- [ ] Popup de visualização
- [ ] Filtros por severidade
- [ ] Export formatado para LLM
- [ ] Integração com SvelteGrab

### Estimativa Total: 5-6 semanas

---

## Ferramenta 6: Svelte-Render-Profiler

### Descrição

Monitora e reporta re-renders de componentes, identificando renders excessivos e suas causas (props changes, state changes, context updates).

### Problema que Resolve

Performance issues são invisíveis:
- Componentes re-renderizando desnecessariamente
- Props mudando referência a cada render
- Efeitos cascateando updates
- Memory leaks por subscriptions

### Output Exemplo

```
=== Render Profile: últimos 10 segundos ===

🔴 HOT COMPONENTS (re-renders excessivos):

  1. <ProductCard> - 147 renders
     │ 📍 src/lib/ProductCard.svelte
     │
     │ 🔍 CAUSA:
     │    Prop 'product' muda referência a cada render do pai
     │
     │    Pai (<ProductList>) faz:
     │    {#each products as product}
     │      <ProductCard product={{ ...product, selected: isSelected(product.id) }} />
     │                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     │                   Novo objeto criado a cada render!
     │
     │ ✅ SOLUÇÃO:
     │    Mover lógica de 'selected' para dentro do ProductCard
     │    Ou usar $derived para memoizar o objeto

  2. <SearchResults> - 89 renders
     │ 📍 src/lib/SearchResults.svelte
     │
     │ 🔍 CAUSA:
     │    $effect sem dependencies corretas
     │    Re-executa em qualquer mudança de estado
     │
     │ ✅ SOLUÇÃO:
     │    Especificar dependencies explícitas

🟢 COMPONENTES SAUDÁVEIS:

  <Header> - 2 renders ✓
  <Footer> - 1 render ✓
  <Sidebar> - 5 renders ✓

📊 TIMELINE:

  00:00 ─────────────────────────────── 00:10
        ╭─ ProductCard (burst: 50 renders)
        │  │ Trigger: products store update
        │  ╰─ Causa: cada item re-criado
        │
        ╰─ SearchResults (burst: 30 renders)
           │ Trigger: input debounce fail
           ╰─ Causa: effect re-running
```

### Como Funciona Tecnicamente

```
┌─────────────────────────────────────────────────────────┐
│                 Svelte-Render-Profiler                   │
├─────────────────────────────────────────────────────────┤
│  INSTRUMENTAÇÃO (Compile-time):                         │
│  1. Vite plugin injeta tracking code                   │
│  2. Cada componente reporta mount/update/destroy       │
│  3. Captura props/state diff em cada update            │
├─────────────────────────────────────────────────────────┤
│  RUNTIME:                                               │
│  1. Collector central recebe eventos                   │
│  2. Agrupa por componente                              │
│  3. Detecta bursts (muitos renders em pouco tempo)     │
│  4. Analisa causas (qual prop/state mudou)             │
├─────────────────────────────────────────────────────────┤
│  ANÁLISE:                                               │
│  1. Identifica padrões problemáticos                   │
│  2. Correlaciona com código fonte                      │
│  3. Gera sugestões de otimização                       │
└─────────────────────────────────────────────────────────┘
```

### Viabilidade

| Aspecto | Avaliação | Notas |
|---------|-----------|-------|
| Render tracking | ⚠️ Complexo | Requer instrumentação |
| Props diff | ✅ Viável | Shallow compare |
| Burst detection | ✅ Viável | Estatísticas |
| Causa analysis | ⚠️ Parcial | Heurísticas |
| Timeline | ✅ Viável | Event buffer |

**Desafios Técnicos:**
1. Instrumentação adiciona overhead
2. Svelte 5 tem modelo reativo diferente
3. Diferenciar renders "bons" de "ruins"
4. Muitos dados para processar

**Soluções Possíveis:**
1. Sampling ao invés de tracking completo
2. Apenas componentes marcados (@profile)
3. Análise post-hoc ao invés de real-time
4. Integração com Svelte DevTools

### Plano de Implementação

#### Fase 1: Basic Tracking (2 semanas)
- [ ] Vite plugin para instrumentação
- [ ] Contador de renders por componente
- [ ] UI básica de visualização

#### Fase 2: Cause Analysis (3 semanas)
- [ ] Detectar qual prop/state mudou
- [ ] Identificar referential inequality
- [ ] Correlacionar com código

#### Fase 3: Recommendations (2 semanas)
- [ ] Padrões de problemas conhecidos
- [ ] Sugestões de fix
- [ ] Código exemplo de correção

#### Fase 4: Timeline (1 semana)
- [ ] Visualização temporal
- [ ] Correlação de eventos
- [ ] Export de profile

### Estimativa Total: 8-10 semanas

---

## Matriz de Priorização

| Ferramenta | Impacto | Complexidade | Tempo | ROI | Prioridade |
|------------|---------|--------------|-------|-----|------------|
| Svelte-State-Grab | 🔴 Alto | 🟡 Média | 5-8 sem | Alto | **#1** |
| Svelte-Error-Context | 🔴 Alto | 🟢 Baixa | 5-6 sem | Muito Alto | **#2** |
| Svelte-A11y-Reporter | 🟡 Médio | 🟡 Média | 7-8 sem | Médio | **#3** |
| Svelte-Style-Grab | 🟡 Médio | 🔴 Alta | 6-7 sem | Médio | **#4** |
| Svelte-Render-Profiler | 🟡 Médio | 🔴 Alta | 8-10 sem | Baixo | **#5** |
| Svelte-Props-Tracer | 🔴 Alto | 🔴 Alta | 8-10 sem | Médio | **#6** |

---

## Roadmap Sugerido

### Fase 1: Quick Wins (Mês 1-2)
```
Semana 1-6:  Svelte-Error-Context
             └─ Alto impacto, baixa complexidade
             └─ Complementa SvelteGrab imediatamente

Semana 5-8:  Svelte-State-Grab (início paralelo)
             └─ MVP pode ser feature do SvelteGrab
```

### Fase 2: Core Tools (Mês 3-4)
```
Semana 9-16: Svelte-State-Grab (completo)
             └─ Integração profunda com SvelteGrab

Semana 12-18: Svelte-A11y-Reporter
              └─ Pode começar em paralelo
```

### Fase 3: Advanced (Mês 5-6)
```
Semana 19-25: Svelte-Style-Grab
              └─ Requer mais pesquisa de CSS internals

Semana 22-28: Decisão: Props-Tracer ou Render-Profiler
              └─ Baseado em feedback dos usuários
```

### Fase 4: Suite Integration (Mês 7)
```
Semana 29-32: Unificação das ferramentas
              └─ UI compartilhada
              └─ Export combinado para LLMs
              └─ Documentação completa
```

---

## Arquitetura Unificada Proposta

```
┌────────────────────────────────────────────────────────────────┐
│                        Svelte DevKit                            │
│                    (nome sugerido para suite)                   │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ SvelteGrab  │ │ StateGrab   │ │ StyleGrab   │               │
│  │ (location)  │ │ (state)     │ │ (css)       │               │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘               │
│         │               │               │                       │
│  ┌──────┴───────────────┴───────────────┴──────┐               │
│  │              Core Engine                     │               │
│  │  - Element selection                        │               │
│  │  - __svelte_meta access                     │               │
│  │  - Clipboard management                     │               │
│  │  - UI components                            │               │
│  └──────┬───────────────┬───────────────┬──────┘               │
│         │               │               │                       │
│  ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐               │
│  │ ErrorCtx    │ │ A11yReport  │ │ RenderProf  │               │
│  │ (errors)    │ │ (a11y)      │ │ (perf)      │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│                      LLM Export Layer                           │
│  - Formato unificado otimizado para contexto                   │
│  - Priorização de informação relevante                         │
│  - Token-efficient formatting                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Próximos Passos

1. **Validar priorização** com feedback de usuários do SvelteGrab
2. **Começar Svelte-Error-Context** como próximo projeto
3. **Prototipar State-Grab** como feature adicional do SvelteGrab
4. **Definir nome da suite** (Svelte DevKit? Svelte AI Tools?)
5. **Criar repositório monorepo** para todas as ferramentas

---

## Apêndice: Considerações Técnicas

### Svelte 5 vs Svelte 4

| Feature | Svelte 4 | Svelte 5 |
|---------|----------|----------|
| State access | `$$props`, `$$restProps` | `$props()` rune |
| Reactivity | `$:` statements | `$state`, `$derived` |
| Effects | `$:` | `$effect` |
| Internals | Mais expostos | Mais encapsulados |

Svelte 5 é mais "fechado" por design, o que torna algumas ferramentas mais desafiadoras. Pode ser necessário:
- Feature requests para Svelte team
- Hooks de desenvolvimento oficiais
- Colaboração com Svelte DevTools

### Performance Budget

Para ferramentas de dev, aceitável:
- Latência de captura: < 100ms
- Overhead de runtime: < 5% CPU
- Memory: < 10MB adicional
- Bundle size: Lazy load, < 50kb initial

### Compatibilidade

- Browsers: Chrome 90+, Firefox 88+, Safari 14+
- Svelte: 5.x (primary), 4.x (best effort)
- SvelteKit: 2.x
- Vite: 5.x+
