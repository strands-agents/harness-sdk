import { readFile, writeFile } from "fs/promises";

const QUICKSTART_PATH = "src/content/docs/user-guide/sdk/quickstart/overview.mdx";

/**
 * Convert the quickstart overview page to use Starlight cards
 * This handles the MkDocs-style card syntax with icons and converts to Starlight LinkCard/CardGrid
 */
export async function updateQuickstart(): Promise<void> {
  const content = await readFile(QUICKSTART_PATH, "utf-8");
  
  // Check if already converted (has Starlight imports)
  if (content.includes("@astrojs/starlight/components")) {
    console.log(`✓ Quickstart already converted: ${QUICKSTART_PATH}`);
    return;
  }

  const newContent = convertQuickstartToCards(content);
  
  if (newContent !== content) {
    await writeFile(QUICKSTART_PATH, newContent, "utf-8");
    console.log(`✓ Converted quickstart to Starlight cards: ${QUICKSTART_PATH}`);
  }
}

function convertQuickstartToCards(content: string): string {
  // Add the Starlight import at the top (after frontmatter if present)
  const starlightImport = `import { LinkCard, CardGrid } from '@astrojs/starlight/components';`;
  
  let result = content;
  
  // Find where to insert the import (after frontmatter or at the beginning)
  const frontmatterMatch = result.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    const insertPos = frontmatterMatch[0].length;
    result = result.slice(0, insertPos) + "\n" + starlightImport + "\n" + result.slice(insertPos);
  } else {
    // No frontmatter - add import at the very beginning, before the first heading
    const firstHeadingMatch = result.match(/^(#\s+[^\n]+\n)/);
    if (firstHeadingMatch) {
      result = firstHeadingMatch[1] + "\n" + starlightImport + "\n" + result.slice(firstHeadingMatch[0].length);
    } else {
      result = starlightImport + "\n\n" + result;
    }
  }

  // Convert the Python quickstart card
  // Pattern: ## :material-language-python: **Python Quickstart**\n\nDescription\n\n[**→ Link text**](url)\n\n---
  result = result.replace(
    /## :material-language-python: \*\*Python Quickstart\*\*\n\n([^\n]+)\n\n\[\*\*→ [^\*]+\*\*\]\(([^)]+)\)\n\n---\n\n/,
    `<CardGrid>
<LinkCard
  title="Python Quickstart"
  description="$1"
  href="../python/"
/>
`
  );

  // Convert the TypeScript quickstart card
  // Pattern: ## :material-language-typescript: **TypeScript Quickstart**\n\n:::note[...]\n...\n:::\n\nDescription\n\n[**→ Link text**](url)
  result = result.replace(
    /## :material-language-typescript: \*\*TypeScript Quickstart\*\*\n\n:::note\[([^\]]+)\]\n([^\n]+)\n:::\n\n([^\n]+)\n\n\[\*\*→ [^\*]+\*\*\]\(([^)]+)\)\n*/,
    `<LinkCard
  title="TypeScript Quickstart (Experimental)"
  description="$3"
  href="../typescript/"
/>
</CardGrid>
`
  );

  return result;
}

// Allow running standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  updateQuickstart().catch(console.error);
}
