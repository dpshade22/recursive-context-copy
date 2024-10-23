const { Plugin, TFile, Notice, MarkdownView, Modal, Setting } = require('obsidian');

class DepthSelectionModal extends Modal {
    constructor(app, plugin, file) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.depth = 1;
        this.template = plugin.settings.promptTemplate;
        this.templateFile = null;
    }

    getTemplateFiles() {
        const files = this.app.vault.getMarkdownFiles();
        // Look for files in template folders or with template-related names
        return files.filter(file => {
            const path = file.path.toLowerCase();
            return path.includes('template') ||
                path.includes('templates') ||
                path.startsWith('_templates/') ||
                path.startsWith('.templates/') ||
                file.basename.toLowerCase().startsWith('template');
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select recursion depth and customize prompt' });

        // Depth selector
        new Setting(contentEl)
            .setName('Depth')
            .setDesc('Choose recursion depth (1-4)')
            .addSlider(slider => slider
                .setLimits(1, 4, 1)
                .setValue(1)
                .setDynamicTooltip()
                .onChange(value => {
                    this.depth = value;
                }));

        // Template file selector with dropdown
        const templateSetting = new Setting(contentEl)
            .setName('Template File')
            .setDesc('Select a template file for the LLM to follow (optional)')
            .addDropdown(dropdown => {
                // Add empty option
                dropdown.addOption('', 'No template');

                // Add template files
                const templateFiles = this.getTemplateFiles();
                templateFiles.forEach(file => {
                    dropdown.addOption(file.path, file.basename);
                });

                dropdown.onChange(async (value) => {
                    if (value) {
                        this.templateFile = this.app.vault.getAbstractFileByPath(value);
                        // Optionally show template content preview
                        if (this.templateFile instanceof TFile) {
                            const content = await this.app.vault.read(this.templateFile);
                            this.updateTemplatePreview(content);
                        }
                    } else {
                        this.templateFile = null;
                        this.updateTemplatePreview('');
                    }
                });
            });

        // Add template preview area
        const previewContainer = contentEl.createDiv();
        previewContainer.style.margin = '1em 0';
        previewContainer.style.display = 'none';

        const previewLabel = previewContainer.createEl('div', {
            text: 'Template Preview:',
            cls: 'setting-item-name'
        });

        const preview = previewContainer.createEl('pre', {
            cls: 'template-preview'
        });

        this.previewContainer = previewContainer;
        this.previewElement = preview;

        // Create a container for the prompt text area
        const textAreaContainer = contentEl.createDiv();
        textAreaContainer.style.margin = '1em 0';

        // Add the prompt text area
        const textArea = textAreaContainer.createEl('textarea', {
            cls: 'template-textarea'
        });
        textArea.value = this.template;
        textArea.addEventListener('input', (e) => {
            this.template = e.target.value;
        });

        // Add the copy button at the bottom
        const buttonContainer = contentEl.createDiv({
            cls: 'copy-button-container'
        });

        const copyButton = buttonContainer.createEl('button', {
            text: 'Copy',
            cls: 'mod-cta'
        });
        copyButton.addEventListener('click', async () => {
            await this.plugin.copyFileAndLinks(
                this.file,
                this.depth,
                this.template,
                this.templateFile
            );
            this.close();
        });
    }

    updateTemplatePreview(content) {
        if (content) {
            this.previewElement.setText(content);
            this.previewContainer.style.display = 'block';
        } else {
            this.previewElement.setText('');
            this.previewContainer.style.display = 'none';
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class RecursiveCopyPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'copy-file-and-links',
            name: 'Copy File and Links Content',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;

                if (!checking) {
                    new DepthSelectionModal(this.app, this, view.file).open();
                }
                return true;
            }
        });

        this.fileMenuEventRef = this.app.workspace.on('file-menu', (menu, file) => {
            if (file instanceof TFile && file.extension === 'md') {
                menu.addItem((item) => {
                    item
                        .setTitle('Copy file and links')
                        .setIcon('files')
                        .onClick(() => new DepthSelectionModal(this.app, this, file).open());
                });
            }
        });

        this.registerEvent(this.fileMenuEventRef);

    }

    onunload() {
        this.app.workspace.offref(this.fileMenuEventRef);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async copyFileAndLinks(file, maxDepth, template, templateFile) {
        const visited = new Set();
        const fileTree = await this.buildFileTree(file, maxDepth, visited);
        const content = await this.renderFileTree(fileTree);
        let templateContent = '';

        if (templateFile) {
            templateContent = await this.app.vault.read(templateFile);
        }

        const prompt = this.generateLLMPrompt(
            file.basename,
            content,
            maxDepth,
            template,
            templateContent
        );

        await navigator.clipboard.writeText(prompt);
        new Notice(`Copied LLM prompt to clipboard (depth: ${maxDepth})`);
    }

    getForwardLinks(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const links = new Set();

        if (cache?.links) {
            for (const link of cache.links) {
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
                if (linkedFile instanceof TFile) {
                    links.add(linkedFile);
                }
            }
        }

        return Array.from(links);
    }

    async buildFileTree(file, maxDepth, visited, currentDepth = 0, isBacklink = true) {
        if (currentDepth > maxDepth || visited.has(file.path)) {
            return null;
        }

        visited.add(file.path);

        const node = {
            file: file,
            content: await this.app.vault.read(file),
            depth: currentDepth,
            backlinks: [],
            forwardLinks: []
        };

        // Process backlinks only at depth 0
        if (currentDepth === 0) {
            const backlinks = this.app.metadataCache.getBacklinksForFile(file);
            if (backlinks) {
                for (const [path, refs] of backlinks.data) {
                    const backlinkFile = this.app.vault.getAbstractFileByPath(path);
                    if (backlinkFile instanceof TFile && !visited.has(backlinkFile.path)) {
                        // Process the backlink file
                        const backlinkNode = await this.buildFileTree(
                            backlinkFile,
                            maxDepth,
                            new Set(visited), // Create a new visited set for each backlink branch
                            currentDepth + 1,
                            true
                        );
                        if (backlinkNode) {
                            node.backlinks.push(backlinkNode);
                        }
                    }
                }
            }
        }

        // Always process forward links for both the original file and backlinks
        const forwardLinks = this.getForwardLinks(file);
        for (const linkedFile of forwardLinks) {
            if (!visited.has(linkedFile.path)) {
                const linkedNode = await this.buildFileTree(
                    linkedFile,
                    maxDepth,
                    visited,
                    currentDepth + 1,
                    false
                );
                if (linkedNode) {
                    node.forwardLinks.push(linkedNode);
                }
            }
        }

        return node;
    }

    getForwardLinks(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const links = new Set();

        // Check both links and embeds
        if (cache) {
            // Check regular links
            if (cache.links) {
                for (const link of cache.links) {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
                    if (linkedFile instanceof TFile) {
                        links.add(linkedFile);
                    }
                }
            }

            // Check embedded links
            if (cache.embeds) {
                for (const embed of cache.embeds) {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
                    if (linkedFile instanceof TFile) {
                        links.add(linkedFile);
                    }
                }
            }
        }

        return Array.from(links);
    }


    async renderFileTree(node, indent = '') {
        if (!node) return '';

        let content = '';
        const depthIndicator = node.depth > 0 ? ` (Depth ${node.depth})` : '';

        content += `# ${node.file.basename}${depthIndicator}\n\n`;
        content += node.content;
        content += '\n\n---\n\n';

        if (node.backlinks.length > 0) {
            content += `# Backlinks to ${node.file.basename}${depthIndicator}\n\n`;
            for (const backlink of node.backlinks) {
                content += await this.renderFileTree(backlink, indent + '  ');
            }
        }

        if (node.forwardLinks.length > 0) {
            content += `# Forward Links from ${node.file.basename}${depthIndicator}\n\n`;
            for (const forwardLink of node.forwardLinks) {
                content += await this.renderFileTree(forwardLink, indent + '  ');
            }
        }

        return content;
    }

    generateLLMPrompt(filename, content, depth, template, templateContent) {
        let prompt = template
            .replace('{filename}', filename)
            .replace('{depth}', depth)
            .replace('{content}', content);

        if (templateContent) {
            prompt += `\n\nPlease follow this template structure when creating the new note:\n\n${templateContent}`;
        }

        return prompt;
    }
}

const DEFAULT_SETTINGS = {
    promptTemplate: `Based on the following content from "{filename}", its backlinks, and forward links (recursion depth: {depth}), analyze and synthesize the information to create an enhanced Obsidian note. Consider the following aspects:

1. Key Concepts:
   - Identify and explain main ideas
   - Highlight important relationships between concepts
   - Suggest potential connections to other topics

2. Knowledge Structure:
   - Create a hierarchical organization of information
   - Identify gaps in the current content
   - Propose areas for further research

3. Obsidian-Specific Features:
   - Suggest relevant internal links ([[link]])
   - Recommend appropriate tags (#tag)
   - Identify opportunities for MOCs (Maps of Content)

Here's the source content:

{content}

Please provide a comprehensive response that includes:
1. A structured summary of the key points
2. Suggested connections and relationships
3. Potential areas for expansion
4. Recommended tags and links
5. Any additional insights or patterns you've identified

Format the response in an Obsidian-flavored Markdown codeblock, utilizing appropriate syntax for links, tags, and other Obsidian features.`
};

module.exports = RecursiveCopyPlugin;
