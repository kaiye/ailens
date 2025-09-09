// AI Lens Dashboard JavaScript
let vscode;

// Safely acquire VS Code API
try {
    if (typeof acquireVsCodeApi !== 'undefined') {
        vscode = acquireVsCodeApi();
    }
} catch (error) {
    console.error('Failed to acquire VS Code API:', error);
}

// 全局变量
let currentSort = { field: 'percentage', direction: 'desc' };
let filesData = [];

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 请求初始数据
    if (vscode) {
        vscode.postMessage({ type: 'getInitialData' });
    }
    
    // 监听来自扩展的消息
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'initialData':
                updateDashboard(message.data);
                break;
            case 'statsUpdate':
                updateDashboard(message.data);
                break;
            case 'error':
                showError(message.message);
                break;
        }
    });
});

function refreshData() {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('error').style.display = 'none';
    if (vscode) {
        vscode.postMessage({ type: 'refresh' });
    }
}

function exportData() {
    if (vscode) {
        vscode.postMessage({ type: 'export' });
    }
}

function openFile(fileName) {
    if (vscode) {
        vscode.postMessage({ type: 'openFile', fileName: fileName });
    }
}

function updateDashboard(data) {
    const { stats, dbStatus, workspace, detailedFileStats, gitCommitAnalysis, totalProjectLines, timestamp } = data;
    
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'none';
    
    // Update workspace info
    if (workspace) {
        document.getElementById('workspace-info').style.display = 'block';
        document.getElementById('workspace-name').textContent = workspace.name;
        document.getElementById('workspace-path').textContent = workspace.path;
        
        // Update Git info
        if (workspace.git && workspace.git.hasGit) {
            document.getElementById('git-info').style.display = 'block';
            const gitElement = document.getElementById('git-repository');
            if (workspace.git.remoteUrl) {
                gitElement.innerHTML = '<a href="' + workspace.git.remoteUrl + '" target="_blank" style="color: var(--accent-blue); text-decoration: none;">' + workspace.git.displayUrl + '</a>';
            } else {
                gitElement.textContent = workspace.git.displayUrl;
                gitElement.style.color = 'var(--text-secondary)';
            }
        } else {
            document.getElementById('git-info').style.display = 'none';
        }
    } else {
        document.getElementById('workspace-info').style.display = 'none';
    }
    
    // Calculate AI in used statistics from detailed file stats
    let totalAIInUsed = 0;
    let totalTabInUsed = 0;
    let totalComposerInUsed = 0;
    
    if (detailedFileStats) {
        for (const [fileName, fileStats] of Object.entries(detailedFileStats)) {
            totalAIInUsed += fileStats.aiLines || 0;
            totalTabInUsed += fileStats.tabLines || 0;
            totalComposerInUsed += fileStats.composerLines || 0;
        }
    }
    
    // Use totalProjectLines for the entire project calculation, fallback to 0
    const actualTotalProjectLines = totalProjectLines || 0;
    const aiInUsedPercentage = actualTotalProjectLines > 0 ? (totalAIInUsed / actualTotalProjectLines * 100) : 0;
    
    // Update first row stats (AI metrics)
    document.getElementById('aiLines').textContent = stats.aiGeneratedLines.toLocaleString();
    document.getElementById('tabLines').textContent = stats.tabCompletionLines.toLocaleString();
    document.getElementById('composerLines').textContent = stats.composerLines.toLocaleString();
    
    // Update progress bar for AI Generated (guard if element not present)
    const aiProgressEl = document.getElementById('aiProgress');
    if (aiProgressEl) {
        aiProgressEl.style.width = Math.min(stats.percentage, 100) + '%';
    }
    
    // Update second row stats (Usage metrics)
    document.getElementById('totalLines').textContent = actualTotalProjectLines.toLocaleString();
    document.getElementById('aiInUsed').textContent = totalAIInUsed.toLocaleString();
    document.getElementById('aiPercentageInUsed').textContent = aiInUsedPercentage.toFixed(2) + '%';
    
    // Update progress bar for AI In Used
    document.getElementById('aiInUsedProgress').style.width = Math.min(aiInUsedPercentage, 100) + '%';
    
    // Update last update time
    const lastUpdate = new Date(timestamp).toLocaleTimeString();
    document.getElementById('lastUpdate').textContent = 'Last update: ' + lastUpdate;
    
    // Update Git commits analysis
    updateGitCommitsAnalysis(gitCommitAnalysis);
    
    // Update files table
    updateFilesTable(stats.files, detailedFileStats);
}

function updateFilesTable(filesMap, detailedFileStats) {
    // Use detailed stats if available, otherwise fall back to basic stats
    if (detailedFileStats) {
        // Convert detailed stats object to array and filter out files with 0% AI
        filesData = Object.entries(detailedFileStats)
            .map(([fileName, fileStats]) => ({ fileName, ...fileStats }))
            .filter(fileData => fileData.percentage > 0 || fileData.aiLines > 0);
    } else {
        // Fallback to basic stats and filter out files with 0% AI
        filesData = Array.from(filesMap.entries())
            .map(([fileName, fileStats]) => ({ fileName, ...fileStats, tabLines: 0, composerLines: 0, lastModified: 0 }))
            .filter(fileData => fileData.percentage > 0 || fileData.aiLines > 0);
    }

    // Update summary statistics
    updateFilesSummary();
    
    // Update sort headers to show current sort
    updateSortHeaders();
    
    // Apply current sort and render
    sortAndRenderFiles();
}

function updateFilesSummary() {
    if (filesData.length > 0) {
        const summaryDiv = document.getElementById('filesSummary');
        const filesWithAI = filesData.length; // 已经过滤过了，所以都是有AI代码的文件
        const totalTabLines = filesData.reduce((sum, f) => sum + (f.tabLines || 0), 0);
        const totalComposerLines = filesData.reduce((sum, f) => sum + (f.composerLines || 0), 0);
        const totalLinesAcrossFiles = filesData.reduce((sum, f) => sum + (f.totalLines || 0), 0);
        
        summaryDiv.innerHTML = 
            '<div class="summary-stats">' +
            '<span class="summary-item">🤖 <strong>' + filesWithAI + '</strong> files with AI code</span>' +
            '<span class="summary-item">📊 <strong>' + totalLinesAcrossFiles.toLocaleString() + '</strong> total lines in AI files</span>' +
            '<span class="summary-item">⚡ <strong>' + totalTabLines.toLocaleString() + '</strong> tab completions</span>' +
            '<span class="summary-item">💬 <strong>' + totalComposerLines.toLocaleString() + '</strong> composer lines</span>' +
            '</div>';
        summaryDiv.style.display = 'block';
    } else {
        document.getElementById('filesSummary').style.display = 'none';
    }
}

function showError(message) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
}

// 排序功能
function sortTable(field) {
    // 切换排序方向
    if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.direction = 'desc';
    }

    // 更新表头样式
    updateSortHeaders();

    // 排序数据并更新表格
    sortAndRenderFiles();
}

function updateSortHeaders() {
    // 清除所有排序样式
    document.querySelectorAll('.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });

    // 添加当前排序样式
    const currentHeader = document.querySelector("[onclick=\"sortTable('" + currentSort.field + "')\"]");
    if (currentHeader) {
        currentHeader.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
}

function sortAndRenderFiles() {
    if (filesData.length === 0) {
        renderFilesTable([]);
        return;
    }

    const sortedFiles = [...filesData].sort((a, b) => {
        let valueA, valueB;

        switch (currentSort.field) {
            case 'fileName':
                valueA = a.fileName.toLowerCase();
                valueB = b.fileName.toLowerCase();
                break;
            case 'totalLines':
                valueA = a.totalLines || 0;
                valueB = b.totalLines || 0;
                break;
            case 'aiLines':
                valueA = a.aiLines || 0;
                valueB = b.aiLines || 0;
                break;
            case 'tabLines':
                valueA = a.tabLines || 0;
                valueB = b.tabLines || 0;
                break;
            case 'composerLines':
                valueA = a.composerLines || 0;
                valueB = b.composerLines || 0;
                break;
            case 'percentage':
                valueA = a.percentage || 0;
                valueB = b.percentage || 0;
                break;
            case 'lastModified':
                valueA = a.lastModified || 0;
                valueB = b.lastModified || 0;
                break;
            default:
                return 0;
        }

        if (currentSort.direction === 'asc') {
            return valueA > valueB ? 1 : valueA < valueB ? -1 : 0;
        } else {
            return valueA < valueB ? 1 : valueA > valueB ? -1 : 0;
        }
    });

    // 重新渲染表格
    renderFilesTable(sortedFiles);
}

function renderFilesTable(files) {
    const tbody = document.getElementById('filesTable');
    tbody.innerHTML = '';

    files.forEach(file => {
        const row = tbody.insertRow();
        row.onclick = () => openFile(file.fileName);
        row.className = 'file-row';
        
        const nameCell = row.insertCell(0);
        nameCell.innerHTML = '<span class="file-name">' + file.fileName + '</span>';
        nameCell.className = 'file-name-cell';
        
        const totalCell = row.insertCell(1);
        totalCell.textContent = file.totalLines.toLocaleString();
        totalCell.className = 'number-cell';
        
        const aiCell = row.insertCell(2);
        aiCell.textContent = file.aiLines.toLocaleString();
        aiCell.className = 'number-cell';
        
        const tabCell = row.insertCell(3);
        tabCell.textContent = (file.tabLines || 0).toLocaleString();
        tabCell.className = 'number-cell tab-cell';
        
        const composerCell = row.insertCell(4);
        composerCell.textContent = (file.composerLines || 0).toLocaleString();
        composerCell.className = 'number-cell composer-cell';
        
        const percentCell = row.insertCell(5);
        percentCell.textContent = file.percentage.toFixed(2) + '%';
        percentCell.className = 'percentage-cell';
        
        const dateCell = row.insertCell(6);
        if (file.lastModified && file.lastModified > 0) {
            const date = new Date(file.lastModified);
            dateCell.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        } else {
            dateCell.textContent = '-';
        }
        dateCell.className = 'date-cell';
    });

    if (files.length === 0) {
        const row = tbody.insertRow();
        const cell = row.insertCell(0);
        cell.colSpan = 7;
        cell.innerHTML = '🔍 No AI-generated code found in current workspace<br><small>Try using tab completion or chat composer to generate some code first</small>';
        cell.style.textAlign = 'center';
        cell.style.color = 'var(--text-secondary)';
        cell.style.padding = '24px';
        cell.style.lineHeight = '1.5';
    }
}

function updateGitCommitsAnalysis(gitCommitAnalysis) {
    const branchDiv = document.getElementById('currentBranch');
    const branchName = document.getElementById('branchName');
    const tableContainer = document.getElementById('gitCommitsTableContainer');
    const tbody = document.getElementById('gitCommitsTable');
    const noCommits = document.getElementById('noCommits');
    
    // Reset visibility
    branchDiv.style.display = 'none';
    tableContainer.style.display = 'none';
    noCommits.style.display = 'none';
    
    if (!gitCommitAnalysis || !gitCommitAnalysis.recentCommits || gitCommitAnalysis.recentCommits.length === 0) {
        noCommits.style.display = 'block';
        return;
    }
    
    // Show current branch
    if (gitCommitAnalysis.currentBranch) {
        branchName.textContent = gitCommitAnalysis.currentBranch;
        branchDiv.style.display = 'block';
    }
    
    // Show table
    tableContainer.style.display = 'block';
    
    // Clear existing table content
    tbody.innerHTML = '';
    
    // Add each commit as a table row
    gitCommitAnalysis.recentCommits.forEach(commit => {
        const aiPercentage = commit.aiContributionPercentage || 0;
        const row = tbody.insertRow();
        row.className = 'commit-row';
        
        // Commit hash
        const hashCell = row.insertCell(0);
        hashCell.innerHTML = `<span class="commit-hash">${commit.shortHash}</span>`;
        
        // Message
        const messageCell = row.insertCell(1);
        messageCell.innerHTML = `<div class="commit-message" title="${escapeHtml(commit.message)}">${escapeHtml(commit.message)}</div>`;
        
        // Author
        const authorCell = row.insertCell(2);
        authorCell.innerHTML = `<div class="commit-author">${escapeHtml(commit.author)}</div>`;
        
        // Files count
        const filesCell = row.insertCell(3);
        filesCell.innerHTML = `<div class="commit-files-count">${commit.totalFiles}</div>`;
        
        // Total changes (+/-)
        const totalChangesCell = row.insertCell(4);
        totalChangesCell.innerHTML = `
            <div class="commit-changes">
                ${commit.totalAdditions > 0 ? `<span class="change-badge additions">+${commit.totalAdditions}</span>` : ''}
                ${commit.totalDeletions > 0 ? `<span class="change-badge deletions">-${commit.totalDeletions}</span>` : ''}
            </div>
        `;
        
        // AI changes (+/-)
        const aiChangesCell = row.insertCell(5);
        aiChangesCell.innerHTML = `
            <div class="commit-changes">
                ${commit.aiAdditions > 0 ? `<span class="change-badge ai-additions">+${commit.aiAdditions}</span>` : ''}
                ${commit.aiDeletions > 0 ? `<span class="change-badge ai-deletions">-${commit.aiDeletions}</span>` : ''}
            </div>
        `;
        
        // AI percentage
        const aiPercentageCell = row.insertCell(6);
        const percentClass = aiPercentage > 50 ? 'high' : aiPercentage > 20 ? 'medium' : 'low';
        aiPercentageCell.innerHTML = `<div class="ai-percentage ${percentClass}">${aiPercentage.toFixed(1)}%</div>`;
        
        // Date
        const dateCell = row.insertCell(7);
        dateCell.innerHTML = `<div class="commit-date">${formatCommitDate(commit.date)}</div>`;
    });
}


function formatCommitDate(dateString) {
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);
        
        if (diffHours < 1) {
            return 'Just now';
        } else if (diffHours < 24) {
            return `${diffHours}h ago`;
        } else if (diffDays < 7) {
            return `${diffDays}d ago`;
        } else {
            return date.toLocaleDateString();
        }
    } catch (error) {
        return dateString;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
