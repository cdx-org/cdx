export function renderStatsOverviewCard() {
  return `
        <div class="card">
          <div class="card-head">
            <div class="card-title">CDX Stats</div>
            <div class="card-actions">
              <button id="jobsButton" class="tab">List jobs</button>
              <button id="killRun" class="tab danger" title="Force terminate this CDX process" disabled>kill job</button>
            </div>
          </div>
          <div class="body">
            <div class="status-grid">
              <div class="status-item">
                <div class="status-label">run</div>
                <div id="statusRun" class="status-value">-</div>
              </div>
              <div class="status-item">
                <div class="status-label">wait</div>
                <div id="statusWait" class="status-value">-</div>
              </div>
              <div class="status-item">
                <div class="status-label">block</div>
                <div id="statusBlock" class="status-value">-</div>
              </div>
              <div class="status-item">
                <div class="status-label">merge</div>
                <div id="statusMerge" class="status-value">-</div>
              </div>
              <div class="status-item">
                <div class="status-label">done</div>
                <div id="statusDone" class="status-value">-</div>
              </div>
            </div>
            <div class="status-meta">
              <span id="statusElapsed">elapsed: -</span>
              <span id="statusEta">eta: -</span>
              <span id="statusConn">backend: -</span>
            </div>
          </div>
        </div>`;
}

export function renderWorktreeGraphCard() {
  return `
        <div id="worktreeGraphCard" class="card card-flex" style="flex: 1 1 auto; min-height: 0;">
          <h2 id="worktreeGraphTitle">Git Commit History</h2>
          <div class="toolbar">
            <button id="refreshGraph" class="tab">refresh</button>
            <input id="graphLimit" class="input" style="max-width:160px;" placeholder="page size (e.g. 200 or all)" />
            <label class="toggle" title="Show only branch tips and merge commits for CDX worktrees.">
              <input id="graphSimple" type="checkbox" checked />
              <span class="toggle-ui"></span>
              <span>branch/merge</span>
            </label>
            <label class="toggle" data-graph-advanced="1" title="When enabled, includes all refs (equivalent to git log --all).">
              <input id="graphAllRefs" type="checkbox" />
              <span class="toggle-ui"></span>
              <span>all refs</span>
            </label>
            <label class="toggle" data-graph-advanced="1" title="When enabled, automatically loads the next page when you scroll to the top.">
              <input id="graphPageOnScroll" type="checkbox" checked />
              <span class="toggle-ui"></span>
              <span>page on scroll</span>
            </label>
            <select id="graphBadges" class="input" data-graph-advanced="1" style="max-width:150px;">
              <option value="filter">badges: filter</option>
              <option value="all">badges: all</option>
            </select>
            <label class="toggle" data-graph-advanced="1" title="Show incoming changes indicator (requires an upstream for head ref).">
              <input id="graphIncoming" type="checkbox" checked />
              <span class="toggle-ui"></span>
              <span>incoming</span>
            </label>
            <label class="toggle" data-graph-advanced="1" title="Show outgoing changes indicator (requires an upstream for head ref).">
              <input id="graphOutgoing" type="checkbox" checked />
              <span class="toggle-ui"></span>
              <span>outgoing</span>
            </label>
            <label class="toggle" data-graph-advanced="1" title="When enabled, annotates branch tips with current worktree changes (git status --porcelain).">
              <input id="graphWorktreeChanges" type="checkbox" />
              <span class="toggle-ui"></span>
              <span>worktree changes</span>
            </label>
            <label class="toggle" data-graph-advanced="1" title="When enabled, includes untracked files in worktree changes (slower).">
              <input id="graphUntracked" type="checkbox" />
              <span class="toggle-ui"></span>
              <span>untracked</span>
            </label>
          </div>
          <div class="body graph-body">
            <div id="graphMeta" class="graph-meta">graph: -</div>
            <div id="graphScroll" class="graph-scroll">
              <div id="graphList" class="graph-list"></div>
            </div>
          </div>
        </div>`;
}

export function renderCardViewSection() {
  return `
        <div id="cardView" class="card-view">
          <div id="cardHero" class="card card-flex card-hero">
            <div class="card-head">
              <div id="cardHeroTitle" class="card-title">Watchdog Agent</div>
              <div id="cardHeroTags" class="card-tags"></div>
            </div>
            <div class="card-body">
              <div id="cardHeroMeta" class="card-meta"></div>
              <div id="cardHeroText" class="card-text mono"></div>
            </div>
          </div>
        </div>`;
}

export function renderTaskStackSection() {
  return `
        <div id="taskStackView" class="card-view card-view-stack">
          <div id="cardStack" class="card-stack card-list"></div>
          <template id="cardStackTemplate">
            <div class="card card-flex">
              <div class="card-head">
                <div class="card-title"></div>
                <div class="card-tags"></div>
              </div>
              <div class="card-body">
                <div class="card-meta"></div>
                <div class="card-text mono"></div>
              </div>
            </div>
          </template>
        </div>`;
}

export function renderAgentsTasksSection() {
  return `
          <div class="right-mid">
            <div class="card card-flex">
              <h2>Agents</h2>
              <div class="body body-scroll">
                <div id="agentsMeta" class="muted mono" style="margin-bottom:8px;"></div>
                <div id="agents" class="agents"></div>
              </div>
            </div>

            <div class="card card-flex">
              <h2>Tasks</h2>
              <div class="body body-scroll">
                <div id="tasksMeta" class="muted mono" style="margin-bottom:8px;"></div>
                <div id="tasks" class="agents"></div>
              </div>
            </div>
          </div>`;
}

export function renderIoCard() {
  return `
          <div id="ioCard" class="card card-flex">
            <div class="tabs">
              <button id="tabLogs" class="tab active">terminal</button>
              <button id="tabApi" class="tab">api</button>
              <button id="tabWorktree" class="tab">worktree</button>
            </div>

            <div id="panelLogs" class="panel">
              <div class="toolbar">
                <input id="filterInput" class="input" placeholder="filter (substring)" />
              </div>
              <div id="logbox" class="logbox mono"></div>
            </div>

            <div id="panelApi" class="panel" style="display:none;">
              <div class="toolbar">
                <input id="apiFilterInput" class="input" placeholder="filter (substring)" />
                <label class="toggle" title="Show full raw JSON events.">
                  <input id="apiRaw" type="checkbox" />
                  <span class="toggle-ui"></span>
                  <span>raw</span>
                </label>
              </div>
              <div id="apibox" class="logbox mono"></div>
            </div>

            <div id="panelWorktree" class="panel" style="display:none;">
              <div class="toolbar">
                <input id="pathInput" class="input" placeholder="path (relative to worktree)" />
                <button id="worktreeMaxToggle" class="tab" style="margin-left:auto;">maximize</button>
              </div>
              <div class="body worktree-split split">
                <div class="worktree-pane">
                  <div class="pill">tree</div>
                  <div id="tree" class="tree"></div>
                </div>
                <div class="worktree-pane">
                  <div class="pill">preview</div>
                  <div id="file" class="logbox mono"></div>
                  <div class="pill">git status</div>
                  <div id="gitStatus" class="logbox mono"></div>
                </div>
              </div>
            </div>
          </div>`;
}

export function renderGitTreeCard() {
  return `
        <div class="card card-flex">
          <h2>Git Tree</h2>
          <div class="body body-scroll">
            <pre id="testGitTree" class="logbox mono" style="margin:0;"></pre>
          </div>
        </div>`;
}

export function renderTaskDagCard() {
  return `
        <div id="taskDagCard" class="card card-flex">
          <div class="card-head">
            <div id="taskDagTitle" class="card-title">Target Task Table</div>
            <div id="taskDagMeta" class="mono muted">No task data</div>
          </div>
          <div class="body body-scroll" id="testTaskDagWrap">
            <table id="testTaskDagTable" class="task-dag-table" aria-label="Task table"></table>
          </div>
        </div>`;
}

export function renderDashboardLayout() {
  return `
    <div class="layout dashboard-layout">
      <div class="dashboard-sidebar">
        <div class="dashboard-status-panel">
${renderStatsOverviewCard()}
        </div>
        <div class="dashboard-watchdog-panel">
${renderCardViewSection()}
        </div>
      </div>

      <div class="dashboard-main">
${renderTaskDagCard()}
        </div>
      </div>

      <div class="legacy-panels" aria-hidden="true">
${renderWorktreeGraphCard()}
${renderTaskStackSection()}
${renderAgentsTasksSection()}
${renderIoCard()}
      </div>
    `;
}
