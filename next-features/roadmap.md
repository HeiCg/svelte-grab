# SvelteGrab - Roadmap de Features

Inspirado no [react-grab](https://github.com/aidenybai/react-grab) de Aiden Bai.

---

## Fase 1: HTML Preview no Output (Prioridade Alta)

### Objetivo
Incluir um snippet do HTML do elemento capturado no clipboard, dando mais contexto para o coding agent.

### Output Atual
```
in element at src/lib/components/Button.svelte:23
in component at src/lib/components/Form.svelte:45
```

### Output Proposto
```
<button class="btn btn-primary" type="submit">
  Enviar
</button>
in element at src/lib/components/Button.svelte:23
in component at src/lib/components/Form.svelte:45
```

### Implementação

1. **Criar função `getHTMLPreview(element: HTMLElement): string`**
   - Capturar `tagName` do elemento
   - Incluir atributos relevantes (class, id, type, href, etc.)
   - Truncar valores longos (max 50 chars)
   - Incluir texto interno (truncado, max 100 chars)
   - Lidar com elementos filhos (mostrar quantidade ou primeiros 2)

2. **Atributos prioritários** (ordem de importância):
   ```ts
   const PRIORITY_ATTRS = ['class', 'id', 'type', 'href', 'src', 'name', 'placeholder', 'aria-label'];
   ```

3. **Atualizar `formatForAgent()`**
   - Prefixar output com HTML preview
   - Manter formato atual do stack abaixo

4. **Nova prop opcional**
   ```ts
   includeHtml?: boolean; // default: true
   ```

### Arquivos a Modificar
- `src/lib/SvelteGrab.svelte`

### Estimativa
~50 linhas de código

---

## Fase 2: Open in Editor (Prioridade Alta)

### Objetivo
Permitir abrir o arquivo diretamente no editor (VS Code, Cursor, etc.) com um clique.

### Implementação

1. **Criar função `buildEditorUrl(file: string, line: number): string`**
   ```ts
   // VS Code
   `vscode://file/${absolutePath}:${line}`

   // Cursor
   `cursor://file/${absolutePath}:${line}`
   ```

2. **Adicionar botão "Open" no popup**
   - Ícone de link externo
   - Abre via `window.open(url)`

3. **Adicionar atalho de teclado**
   - `O` quando popup aberto = abre primeiro arquivo
   - Click no path = abre aquele arquivo específico

4. **Nova prop para configurar editor**
   ```ts
   editor?: 'vscode' | 'cursor' | 'webstorm' | 'none'; // default: 'vscode'
   ```

5. **Detectar path absoluto**
   - Usar `import.meta.url` ou metadata do Svelte
   - Fallback: assumir path relativo ao projeto

### Arquivos a Modificar
- `src/lib/SvelteGrab.svelte`

### Estimativa
~40 linhas de código

---

## Fase 3: Atalho Cmd+C / Ctrl+C (Prioridade Média)

### Objetivo
Permitir copiar sem precisar clicar - só hover + Cmd+C.

### Comportamento Proposto
1. Usuário segura Alt → entra no selection mode (já implementado)
2. Hover sobre elemento → destaca e mostra tooltip (já implementado)
3. **Novo:** Pressiona Cmd+C (ou Ctrl+C) → copia stack do elemento em hover
4. Não precisa clicar

### Implementação

1. **Interceptar Cmd+C no selection mode**
   ```ts
   function handleKeydown(event: KeyboardEvent) {
     // ... código existente ...

     if (selectionMode && hoveredElement && (event.metaKey || event.ctrlKey) && event.key === 'c') {
       event.preventDefault();
       const stack = getComponentStack(hoveredElement);
       copyToClipboard(formatForAgent(stack));
       // Feedback visual
     }
   }
   ```

2. **Feedback visual rápido**
   - Flash verde no highlight
   - Tooltip muda para "Copied!"

3. **Nova prop opcional**
   ```ts
   copyOnKeyboard?: boolean; // default: true
   ```

### Arquivos a Modificar
- `src/lib/SvelteGrab.svelte`

### Estimativa
~30 linhas de código

---

## Fase 4: Screenshot do Elemento (Prioridade Média)

### Objetivo
Capturar screenshot do elemento selecionado para colar em prompts visuais.

### Dependência
- `html2canvas` ou API nativa `html2canvas`

### Implementação

1. **Adicionar dependência opcional**
   ```bash
   npm install html2canvas
   ```

2. **Criar função `captureScreenshot(element: HTMLElement): Promise<Blob>`**
   - Usar html2canvas para renderizar
   - Converter canvas para blob
   - Copiar para clipboard via `navigator.clipboard.write()`

3. **Adicionar botão "Screenshot" no popup**
   - Ícone de câmera
   - Atalho: `S`

4. **Feedback**
   - "Screenshot copied!"

### Arquivos a Modificar
- `src/lib/SvelteGrab.svelte`
- `package.json` (nova dependência opcional)

### Estimativa
~60 linhas de código

### Considerações
- html2canvas adiciona ~40kb ao bundle
- Fazer lazy import para não impactar quem não usa
- Pode não funcionar com alguns CSS (backdrop-filter, etc.)

---

## Fase 5: Multi-Seleção (Prioridade Baixa)

### Objetivo
Permitir selecionar múltiplos elementos e copiar todos de uma vez.

### Comportamento Proposto
1. Alt+Click = seleciona elemento (adiciona à lista)
2. Alt+Click no mesmo = remove da lista
3. Highlight permanece nos selecionados
4. Popup mostra todos os elementos selecionados
5. Cmd+C copia stack de todos

### Implementação

1. **Novo estado**
   ```ts
   let selectedElements = $state<HTMLElement[]>([]);
   ```

2. **Toggle na seleção**
   - Se já está selecionado, remove
   - Se não está, adiciona

3. **Múltiplos highlights**
   - Renderizar highlight para cada elemento em `selectedElements`

4. **Output combinado**
   ```
   --- Element 1 ---
   <button>Submit</button>
   in element at src/lib/Button.svelte:23

   --- Element 2 ---
   <input type="text" />
   in element at src/lib/Input.svelte:15
   ```

### Arquivos a Modificar
- `src/lib/SvelteGrab.svelte`

### Estimativa
~80 linhas de código

---

## Fase 6: Sistema de Plugins (Prioridade Baixa)

### Objetivo
Permitir extensão via plugins customizados.

### API Proposta
```ts
interface SvelteGrabPlugin {
  name: string;
  actions?: Action[];
  hooks?: {
    onGrab?: (element: HTMLElement, stack: StackEntry[]) => void;
    transformOutput?: (output: string) => string;
  };
}

// Uso
<SvelteGrab plugins={[myPlugin]} />
```

### Considerações
- Adiciona complexidade
- Só implementar se houver demanda real
- Pode ser feito via eventos customizados como alternativa mais simples

---

## Resumo de Prioridades

| Fase | Feature | Impacto | Esforço | Prioridade |
|------|---------|---------|---------|------------|
| 1 | HTML Preview | Alto | Baixo | **Alta** |
| 2 | Open in Editor | Alto | Baixo | **Alta** |
| 3 | Cmd+C sem click | Médio | Baixo | **Média** |
| 4 | Screenshot | Médio | Médio | **Média** |
| 5 | Multi-Seleção | Baixo | Alto | Baixa |
| 6 | Plugins | Baixo | Alto | Baixa |

---

## Próximos Passos

1. [ ] Implementar Fase 1 (HTML Preview)
2. [ ] Implementar Fase 2 (Open in Editor)
3. [ ] Testar em projeto real
4. [ ] Publicar v0.2.0
5. [ ] Coletar feedback
6. [ ] Decidir sobre Fases 3-6

---

## Changelog Planejado

### v0.2.0
- HTML Preview no output
- Botão/atalho para abrir no editor

### v0.3.0
- Atalho Cmd+C no selection mode
- Screenshot do elemento

### v1.0.0
- Multi-seleção
- API estável
- Documentação completa
