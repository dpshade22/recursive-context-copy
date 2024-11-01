const { Plugin, TFile, Notice, MarkdownView, PluginSettingTab, Setting } = require('obsidian');
const https = require('https');

class FabricLinkSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        let { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Fabric Link Settings" });

        new Setting(containerEl)
            .setName('Session ID')
            .setDesc('Enter your Fabric session ID')
            .addText(text => text
                .setPlaceholder('Enter session ID')
                .setValue(this.plugin.settings.sessionId)
                .onChange(async (value) => {
                    this.plugin.settings.sessionId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Web Version')
            .setDesc('Enter the Fabric web version')
            .addText(text => text
                .setPlaceholder('Enter web version')
                .setValue(this.plugin.settings.webVersion)
                .onChange(async (value) => {
                    this.plugin.settings.webVersion = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Cookie')
            .setDesc('Enter your Fabric cookie')
            .addText(text => text
                .setPlaceholder('Enter cookie')
                .setValue(this.plugin.settings.cookie)
                .onChange(async (value) => {
                    this.plugin.settings.cookie = value;
                    await this.plugin.saveSettings();
                }));
    }
}

class InlineFabricSuggest {
    constructor(app, query, editor, cursorPosition, settings) {
        this.app = app;
        this.query = query;
        this.editor = editor;
        this.cursorPosition = cursorPosition;
        this.settings = settings;
        this.results = [];
        this.suggestEl = null;
        this.selectedIndex = 0; // Track the selected index
    }

    async show() {
        console.log('Showing inline fabric suggest box');

        // Create suggestion container
        this.suggestEl = document.createElement('div');
        this.suggestEl.className = 'fabric-link-suggest';
        this.suggestEl.tabIndex = -1; // Make it focusable

        // Get cursor position and position the suggestion box
        const editorRect = this.editor.containerEl.getBoundingClientRect();
        const lineHeight = parseInt(getComputedStyle(this.editor.containerEl).lineHeight);
        const cursorLine = this.cursorPosition.line;

        // Position below the current line
        this.suggestEl.style.left = `${editorRect.left + 50}px`; // Add some left padding
        this.suggestEl.style.top = `${editorRect.top + ((cursorLine + 1.5) * lineHeight)}px`;

        // Add loading state
        const loadingEl = document.createElement('div');
        loadingEl.className = 'fabric-link-loading';
        loadingEl.textContent = 'Loading...';
        this.suggestEl.appendChild(loadingEl);

        // Add to DOM
        document.body.appendChild(this.suggestEl);

        // Fetch and display results
        await this.fetchResults(20); // Fetch with a default page size of 20

        // Initialize selectedIndex
        this.selectedIndex = 0;

        // Handle clicks outside
        document.addEventListener('click', this.handleClickOutside);

        // Handle keyboard navigation
        document.addEventListener('keydown', this.handleKeyDown);

        // Auto-focus the suggestion box
        this.suggestEl.focus();
    }

    handleClickOutside = (e) => {
        if (!this.suggestEl.contains(e.target)) {
            this.close();
        }
    }

    handleKeyDown = (e) => {
        if (!this.suggestEl) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectNext();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectPrevious();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.results.length > 0) {
                    this.insertLink(this.results[this.selectedIndex]);
                    this.close();
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                break;
        }
    }

    selectNext() {
        this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
        this.highlightResult(this.selectedIndex);
    }

    selectPrevious() {
        this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
        this.highlightResult(this.selectedIndex);
    }

    highlightResult(index) {
        const results = this.suggestEl.querySelectorAll('.fabric-link-result');
        results.forEach((el, i) => {
            el.classList.toggle('is-selected', i === index);
        });
        this.scrollSelectedIntoView();
    }

    scrollSelectedIntoView() {
        const selectedEl = this.suggestEl.querySelector('.fabric-link-result.is-selected');
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    selectCurrent() {
        if (this.results.length > 0) {
            this.insertLink(this.results[this.selectedIndex]);
            this.close();
        }
    }

    updateSelection() {
        const results = this.suggestEl.querySelectorAll('.fabric-link-result');
        results.forEach((el, i) => {
            el.classList.toggle('is-selected', i === this.selectedIndex);
        });
    }

    async fetchResults(count) {
        console.log('Fetching results...');
        const options = {
            hostname: 'api.fabric.so',
            path: '/v2/search',
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'accept-language': 'en-US,en;q=0.7',
                'cache-control': 'no-cache',
                'content-type': 'application/json',
                'cookie': this.settings.cookie || '',
                'or-sessionid': this.settings.sessionId,
                'origin': 'https://go.fabric.so',
                'referer': 'https://go.fabric.so/',
                'web-version': this.settings.webVersion
            }
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const jsonData = JSON.parse(data);
                            this.results = jsonData.hits;
                            console.log('Results fetched:', this.results);
                            this.updateSuggestions();
                            resolve(this.results); // Resolve with the results
                        } catch (err) {
                            console.error('Error parsing response:', err);
                            reject(err);
                        }
                    } else {
                        const error = new Error(`HTTP error! status: ${res.statusCode}`);
                        new Notice('Failed to fetch Fabric results. Please update your cookie in settings.');
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('Error:', error);
                new Notice('Failed to fetch Fabric results. Please update your cookie in settings.');
                reject(error);
            });

            const postData = JSON.stringify({
                mode: "hybrid",
                text: this.query,
                filters: { hasSlug: false },
                pagination: { page: 1, pageSize: count }
            });

            req.write(postData);
            req.end();
        });
    }

    updateSuggestions() {
        // Check if suggestEl exists
        if (!this.suggestEl) {
            console.warn('Suggestion element does not exist. Creating a new one.');
            this.suggestEl = document.createElement('div');
            this.suggestEl.className = 'fabric-link-suggest';
            document.body.appendChild(this.suggestEl);
        }

        // Clear previous content
        this.suggestEl.innerHTML = '';

        this.results.forEach((hit, index) => {
            const resultEl = document.createElement('div');
            resultEl.className = 'fabric-link-result';

            // Add thumbnail only if available
            if (hit.thumbnail && hit.thumbnail.sm) {
                const imgEl = document.createElement('img');
                imgEl.className = 'fabric-link-thumbnail';
                imgEl.src = hit.thumbnail.sm;
                imgEl.onerror = () => imgEl.style.display = 'none';
                resultEl.appendChild(imgEl);
            }

            // Add name
            const nameEl = document.createElement('div');
            nameEl.className = 'fabric-link-name';
            nameEl.textContent = hit.name;
            resultEl.appendChild(nameEl);

            // Handle click
            resultEl.addEventListener('click', () => {
                this.insertLink(hit);
                this.close();
            });

            this.suggestEl.appendChild(resultEl);
        });

        this.updateSelection(); // Update selection after adding results
    }

    insertLink(hit) {
        const fabricLink = `https://go.fabric.so/?search=global&expandedFdocId=${hit.id}`;
        const linkText = `[${hit.name}](${fabricLink})`;

        // Replace "f[[" with the complete link
        const currentLine = this.editor.getLine(this.cursorPosition.line);
        const beforeCursor = currentLine.substring(0, this.cursorPosition.ch);
        const afterCursor = currentLine.substring(this.cursorPosition.ch);
        const triggerStart = beforeCursor.lastIndexOf('f[');

        const newLine = beforeCursor.substring(0, triggerStart) + linkText + afterCursor.replace(/\]$/, '');
        this.editor.setLine(this.cursorPosition.line, newLine);
    }

    close() {
        if (this.suggestEl) {
            this.suggestEl.remove();
            this.suggestEl = null;
        }
        document.removeEventListener('click', this.handleClickOutside);
        document.removeEventListener('keydown', this.handleKeyDown);
    }
}

class FabricLink extends Plugin {
    async onload() {
        console.log('Loading FabricLink plugin');

        // Initialize default settings
        const DEFAULT_SETTINGS = {
            sessionId: '3027797638132995959',
            webVersion: '0.1.16',
            cookie: ''
        };

        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        await this.saveSettings();

        this.addSettingTab(new FabricLinkSettingTab(this.app, this));

        this.registerEvent(
            this.app.workspace.on("editor-change", (editor, changeObj) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const beforeCursor = line.substring(0, cursor.ch);

                const matchQuickList = beforeCursor.match(/!fab$/);
                if (matchQuickList) {
                    const count = Math.min(parseInt(matchQuickList[1]), 20);
                    this.insertTopResults(editor, cursor, count);
                } else if (beforeCursor.endsWith('f[')) {
                    const searchText = editor.getValue();
                    new InlineFabricSuggest(this.app, searchText, editor, cursor, this.settings).show();
                }
            })
        );
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, {
            sessionId: '3027797638132995959',
            webVersion: '0.1.16',
            cookie: ''
        }, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async insertTopResults(editor, cursor, count) {
        if (isNaN(count) || count <= 0) {
            count = 4; // Default to 10 if count is not a valid integer
        }
        console.log(`Inserting top results with count: ${count}`);
        try {
            const searchText = editor.getValue();
            console.log(`Search text:`, searchText);

            // Create temporary InlineFabricSuggest instance to use its fetchResults method
            const suggester = new InlineFabricSuggest(this.app, searchText, editor, cursor, this.settings);
            const results = await suggester.fetchResults(count);
            console.log(`Fetched results:`, results);
            if (results && results.length > 0) {
                const listItems = results.map(hit => `- [${hit.name}](https://go.fabric.so/?search=global&expandedFdocId=${hit.id})`);
                const listText = listItems.join('\n');

                const currentLine = editor.getLine(cursor.line);
                const beforeCursor = currentLine.substring(0, cursor.ch);
                const afterCursor = currentLine.substring(cursor.ch);
                const triggerStart = beforeCursor.lastIndexOf('!fab');

                const header = "**Fabric links:**\n"; // Add header line
                const newText = beforeCursor.substring(0, triggerStart) + header + listText + afterCursor;
                editor.replaceRange(newText, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: currentLine.length });
                console.log(`Inserted new text:`, newText);
            } else {
                console.log('No results found to insert.');
                new Notice('No Fabric results found.');
            }
        } catch (error) {
            console.error('Error inserting top results:', error);
            new Notice('Failed to fetch Fabric results. Please update your cookie in settings.');
        }
    }
}

module.exports = {
    default: FabricLink,
    FabricLinkSettingTab
};
