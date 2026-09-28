/* Human play logger and ZIP exporter.
 *
 * The logger is intentionally independent from the AI benchmark database.
 * One game owns a set of per-turn IndexedDB records so a long play session
 * survives navigation/reload better than a single giant in-memory JSON object.
 */
(function (global) {
    'use strict';

    const DB_NAME = 'puyoAI-human-logs';
    const DB_VERSION = 1;
    const SETTINGS_KEY = 'puyoAI.humanLogEnabled';
    const SCHEMA_VERSION = 1;
    const BOARD_CELLS = 6 * 14;
    const STATE = {
        enabled: false,
        db: null,
        gameId: '',
        game: null,
        pendingTurn: null,
        pieceSpawnAt: 0,
        gameStartedPerf: 0,
        currentInputStats: emptyInputStats(),
        logicalTurns: 0,
        exporting: false,
        objectUrl: ''
    };

    function emptyInputStats() {
        return {
            left: 0,
            right: 0,
            rotateCW: 0,
            rotateCCW: 0,
            softDrop: 0,
            hardDrop: 0
        };
    }

    function clone(value) {
        if (value == null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function boardSnapshot() {
        if (typeof global.getBoardSnapshot === 'function') {
            return clone(global.getBoardSnapshot());
        }
        return [];
    }

    function heightsFromBoard(snapshot) {
        const heights = [];
        for (let x = 0; x < 6; x++) {
            let h = 0;
            for (let y = 0; y < 14; y++) {
                if (snapshot?.[y]?.[x] !== 0 && snapshot?.[y]?.[x] != null) h = y + 1;
            }
            heights.push(h);
        }
        return heights;
    }

    function occupiedCount(snapshot) {
        let count = 0;
        for (const row of snapshot || []) {
            for (const cell of row || []) {
                if (cell !== 0 && cell != null) count++;
            }
        }
        return count;
    }

    function maxHeight(snapshot) {
        return Math.max(0, ...heightsFromBoard(snapshot));
    }

    function dangerHeight(snapshot) {
        return heightsFromBoard(snapshot)[2] || 0;
    }

    function isAIActive() {
        return typeof global.isPuyoAIAutoEnabled === 'function' &&
            global.isPuyoAIAutoEnabled();
    }

    function isPlayingHumanContext() {
        return STATE.enabled && !isAIActive();
    }

    function setStatus(text) {
        const el = document.getElementById('human-log-status');
        if (el) el.textContent = text;
    }

    function setExportStatus(text) {
        const el = document.getElementById('human-log-export-status');
        if (el) el.textContent = text;
    }

    function updateToggle() {
        const checkbox = document.getElementById('human-log-checkbox');
        if (checkbox) checkbox.checked = STATE.enabled;
    }

    function updateButtons() {
        const exportButton = document.getElementById('human-log-export-button');
        const clearButton = document.getElementById('human-log-clear-button');
        const hasCurrent = !!STATE.gameId;
        if (exportButton) exportButton.disabled = STATE.exporting;
        if (clearButton) clearButton.disabled = STATE.exporting;
        if (!hasCurrent && exportButton) exportButton.title = '保存済みの人間プレイログがある場合は全ログをZIP化します';
    }

    function openDB() {
        if (STATE.db) return Promise.resolve(STATE.db);
        if (!('indexedDB' in global)) {
            return Promise.reject(new Error('このブラウザではIndexedDBが利用できません'));
        }
        return new Promise((resolve, reject) => {
            const request = global.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('games')) {
                    const games = db.createObjectStore('games', { keyPath: 'id' });
                    games.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('turns')) {
                    const turns = db.createObjectStore('turns', { keyPath: 'id' });
                    turns.createIndex('gameId', 'gameId', { unique: false });
                }
                if (!db.objectStoreNames.contains('events')) {
                    const events = db.createObjectStore('events', { keyPath: 'id' });
                    events.createIndex('gameId', 'gameId', { unique: false });
                }
            };
            request.onsuccess = () => {
                STATE.db = request.result;
                STATE.db.onversionchange = () => STATE.db?.close();
                resolve(STATE.db);
            };
            request.onerror = () => reject(request.error || new Error('人間ログのIndexedDBを開けませんでした'));
        });
    }

    async function putGame(game) {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('games', 'readwrite');
            tx.objectStore('games').put(game);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('人間ログのゲーム情報を保存できませんでした'));
            tx.onabort = () => reject(tx.error || new Error('人間ログのゲーム情報保存が中断されました'));
        });
    }

    async function putTurn(turn) {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('turns', 'readwrite');
            tx.objectStore('turns').put(turn);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`人間ログ ${turn.turn} 手目の保存に失敗しました`));
            tx.onabort = () => reject(tx.error || new Error(`人間ログ ${turn.turn} 手目の保存が中断されました`));
        });
    }

    async function putEvent(event) {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('events', 'readwrite');
            tx.objectStore('events').put(event);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('人間ログイベントの保存に失敗しました'));
            tx.onabort = () => reject(tx.error || new Error('人間ログイベント保存が中断されました'));
        });
    }

    async function getAllGames() {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('games', 'readonly');
            const req = tx.objectStore('games').getAll();
            req.onsuccess = () => {
                const games = Array.isArray(req.result) ? req.result : [];
                games.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
                resolve(games);
            };
            req.onerror = () => reject(req.error || new Error('人間ログ一覧を読み込めませんでした'));
        });
    }

    async function getTurns(gameId) {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('turns', 'readonly');
            const index = tx.objectStore('turns').index('gameId');
            const req = index.getAll(gameId);
            req.onsuccess = () => {
                const turns = Array.isArray(req.result) ? req.result : [];
                turns.sort((a, b) => Number(a.turn) - Number(b.turn));
                resolve(turns);
            };
            req.onerror = () => reject(req.error || new Error('人間ログの手数データを読み込めませんでした'));
        });
    }

    async function getEvents(gameId) {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('events', 'readonly');
            const index = tx.objectStore('events').index('gameId');
            const req = index.getAll(gameId);
            req.onsuccess = () => {
                const events = Array.isArray(req.result) ? req.result : [];
                events.sort((a, b) => Number(a.sequence) - Number(b.sequence));
                resolve(events);
            };
            req.onerror = () => reject(req.error || new Error('人間ログイベントを読み込めませんでした'));
        });
    }

    function currentUpcomingPairs() {
        if (typeof global.getUpcomingPairs === 'function') {
            return clone(global.getUpcomingPairs(5));
        }
        return [];
    }

    function currentQueueIndex() {
        return Number.isFinite(global.queueIndex) ? Number(global.queueIndex) : null;
    }

    function currentPendingOjama() {
        return typeof global.getPendingOjama === 'function'
            ? Number(global.getPendingOjama()) || 0
            : 0;
    }

    function makeGameId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    async function finishCurrentGame(status) {
        if (!STATE.game) return;
        STATE.game.status = status || STATE.game.status || 'complete';
        STATE.game.endedAt = new Date().toISOString();
        STATE.game.lastUpdatedAt = Date.now();
        try { await putGame(STATE.game); } catch (error) { console.warn('[Human log]', error); }
    }

    async function beginGame(reason = 'reset') {
        if (!STATE.enabled) return;

        if (STATE.game) {
            await finishCurrentGame(reason === 'initial' ? 'replaced' : 'reset');
        }

        const initialBoard = boardSnapshot();
        const current = typeof global.getCurrentPuyoState === 'function'
            ? clone(global.getCurrentPuyoState())
            : null;
        STATE.gameId = makeGameId();
        STATE.logicalTurns = 0;
        STATE.pendingTurn = null;
        STATE.gameStartedPerf = performance.now();
        STATE.pieceSpawnAt = STATE.gameStartedPerf;
        STATE.currentInputStats = emptyInputStats();

        STATE.game = {
            schemaVersion: SCHEMA_VERSION,
            type: 'puyoAI-human-play-log',
            id: STATE.gameId,
            status: 'playing',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            lastUpdatedAt: Date.now(),
            startReason: reason,
            browser: global.navigator?.userAgent || 'unknown',
            boardSize: { width: 6, height: 14, hiddenRows: 2 },
            gameMode: global.getGameState ? global.getGameState() : 'playing',
            settings: typeof global.getHumanLogGameSettings === 'function'
                ? clone(global.getHumanLogGameSettings())
                : {
                    autoDropEnabled: null,
                    gravityWaitTime: null,
                    chainWaitTime: null
                },
            initialBoard,
            initialHeights: heightsFromBoard(initialBoard),
            initialUpcomingPairs: currentUpcomingPairs(),
            initialQueueIndex: currentQueueIndex(),
            initialCurrentPuyo: current,
            turnsCount: 0,
            maxChain: 0,
            totalChains: 0,
            totalErased: 0,
            totalScoreDelta: 0,
            finalScore: 0,
            gameOverTurn: null,
            gameOverReason: null,
            notes: ''
        };

        try {
            await putGame(STATE.game);
            setStatus('記録中: 0手 / 最大連鎖 0');
            setExportStatus('');
        } catch (error) {
            setStatus(`人間ログ開始に失敗: ${error?.message || error}`);
            console.error('[Human log]', error);
        }
        updateToggle();
        updateButtons();
    }

    async function syncOnInitialization() {
        STATE.enabled = readEnabled();
        updateToggle();
        if (!STATE.enabled) {
            STATE.game = null;
            STATE.gameId = '';
            setStatus('OFF: 人間プレイは記録していません');
            updateButtons();
            return;
        }
        await beginGame('initial');
        observeSpawnFromGlobal();
    }

    function readEnabled() {
        try { return localStorage.getItem(SETTINGS_KEY) === 'true'; } catch (_) { return false; }
    }

    function setEnabled(enabled) {
        STATE.enabled = !!enabled;
        try { localStorage.setItem(SETTINGS_KEY, STATE.enabled ? 'true' : 'false'); } catch (_) {}
        updateToggle();
        if (!STATE.enabled) {
            void finishCurrentGame('disabled');
            STATE.pendingTurn = null;
            setStatus('OFF: 人間プレイは記録していません');
        } else {
            void beginGame('enabled');
        }
        updateButtons();
    }

    function observeSpawnFromGlobal() {
        if (!STATE.enabled || !STATE.game) return;
        const current = typeof global.getCurrentPuyoState === 'function'
            ? global.getCurrentPuyoState()
            : null;
        if (!current) return;
        STATE.pieceSpawnAt = performance.now();
        STATE.currentInputStats = emptyInputStats();
        STATE.currentPuyo = clone(current);
        STATE.currentUpcomingPairs = currentUpcomingPairs();
    }

    function beginTurn(info) {
        if (!isPlayingHumanContext() || !STATE.game || STATE.pendingTurn) return;

        const before = clone(info.boardBefore || boardSnapshot());
        const current = clone(info.currentPuyo || global.currentPuyo || null);
        STATE.logicalTurns += 1;
        STATE.pendingTurn = {
            schemaVersion: SCHEMA_VERSION,
            attemptId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            gameId: STATE.gameId,
            turn: STATE.logicalTurns,
            timestamp: new Date().toISOString(),
            elapsedMs: Math.max(0, Math.round(performance.now() - (STATE.gameStartedPerf || performance.now()))),
            thinkMs: Math.max(0, Math.round(performance.now() - (STATE.pieceSpawnAt || performance.now()))),
            boardBefore: before,
            boardBeforeHeights: heightsFromBoard(before),
            occupiedBefore: occupiedCount(before),
            currentPair: current ? {
                main: Number(current.mainColor) || 0,
                sub: Number(current.subColor) || 0
            } : null,
            upcomingPairs: clone(info.upcomingPairs || STATE.currentUpcomingPairs || currentUpcomingPairs()),
            queueIndexBeforeLock: info.queueIndexBeforeLock ?? currentQueueIndex(),
            placement: {
                mainX: Number(current?.mainX ?? 2),
                mainY: Number(current?.mainY ?? 0),
                rotation: Number(current?.rotation ?? 0),
                cells: clone(info.cells || [])
            },
            hardDrop: !!STATE.currentInputStats.hardDrop,
            inputStats: clone(STATE.currentInputStats),
            scoreBefore: Number(info.scoreBefore ?? 0),
            pendingOjamaBefore: Number(info.pendingOjamaBefore ?? currentPendingOjama()),
            boardAfterPlacement: null,
            boardAfterPlacementHeights: null,
            waves: [],
            chainCount: 0,
            totalErased: 0,
            scoreAfter: null,
            scoreDelta: null,
            pendingOjamaAfter: null,
            allClear: false,
            boardAfter: null,
            boardAfterHeights: null,
            occupiedAfter: null,
            gameOver: false
        };
    }

    function recordPlacedBoard(snapshot) {
        if (!STATE.pendingTurn) return;
        STATE.pendingTurn.boardAfterPlacement = clone(snapshot);
        STATE.pendingTurn.boardAfterPlacementHeights = heightsFromBoard(snapshot);
    }

    function recordControl(type) {
        if (!isPlayingHumanContext()) return;
        if (!Object.prototype.hasOwnProperty.call(STATE.currentInputStats, type)) return;
        STATE.currentInputStats[type] += 1;
        if (type === 'hardDrop' && STATE.pendingTurn) STATE.pendingTurn.hardDrop = true;
    }

    function recordWave(info) {
        if (!STATE.pendingTurn || !isPlayingHumanContext()) return;
        const snapshot = clone(info.board || boardSnapshot());
        const erasedPuyos = Math.max(0, Number(info.erasedPuyos) || 0);
        const garbageCleared = Math.max(0, Number(info.garbageCleared) || 0);
        STATE.pendingTurn.waves.push({
            chain: Math.max(1, Number(info.chain) || 1),
            erasedPuyos,
            garbageCleared,
            totalCleared: erasedPuyos + garbageCleared,
            scoreDelta: Number(info.scoreDelta) || 0,
            boardAfterWave: snapshot,
            heightsAfterWave: heightsFromBoard(snapshot),
            occupiedAfterWave: occupiedCount(snapshot)
        });
        STATE.pendingTurn.totalErased += erasedPuyos + garbageCleared;
    }

    async function finishTurn(info = {}) {
        if (!STATE.pendingTurn || !STATE.game) return;
        const turn = STATE.pendingTurn;
        const after = clone(info.boardAfter || boardSnapshot());
        const finalScore = Number(info.scoreAfter ?? 0);
        const chain = Math.max(0, Number(info.chainCount) || 0);
        const allClear = !!info.allClear;
        turn.chainCount = chain;
        turn.scoreAfter = finalScore;
        turn.scoreDelta = finalScore - turn.scoreBefore;
        turn.pendingOjamaAfter = Number(info.pendingOjamaAfter ?? currentPendingOjama());
        turn.allClear = allClear;
        turn.boardAfter = after;
        turn.boardAfterHeights = heightsFromBoard(after);
        turn.occupiedAfter = occupiedCount(after);
        turn.gameOver = !!info.gameOver;

        STATE.game.turnsCount = Math.max(STATE.game.turnsCount || 0, turn.turn);
        STATE.game.maxChain = Math.max(STATE.game.maxChain || 0, chain);
        STATE.game.totalChains += chain;
        STATE.game.totalErased += turn.totalErased;
        STATE.game.totalScoreDelta += turn.scoreDelta;
        STATE.game.finalScore = finalScore;
        STATE.game.lastUpdatedAt = Date.now();
        if (turn.gameOver) {
            STATE.game.gameOverTurn = turn.turn;
            STATE.game.gameOverReason = info.gameOverReason || 'board';
        }

        try {
            await putTurn({
                id: `${STATE.gameId}:turn:${String(turn.turn).padStart(5, '0')}:${turn.attemptId}`,
                ...turn
            });
            await putGame(STATE.game);
            setStatus(`記録中: ${STATE.game.turnsCount}手 / 最大連鎖 ${STATE.game.maxChain}`);
        } catch (error) {
            setStatus(`人間ログ保存エラー: ${error?.message || error}`);
            console.error('[Human log]', error);
        } finally {
            STATE.pendingTurn = null;
            STATE.currentInputStats = emptyInputStats();
        }
    }

    async function markGameOver(reason = 'gameover') {
        if (!STATE.game) return;
        if (STATE.pendingTurn) {
            await finishTurn({
                boardAfter: boardSnapshot(),
                scoreAfter: Number(global.score) || 0,
                chainCount: Number(global.chainCount) || 0,
                pendingOjamaAfter: currentPendingOjama(),
                allClear: false,
                gameOver: true,
                gameOverReason: reason
            });
        }
        STATE.game.status = 'gameover';
        STATE.game.endedAt = new Date().toISOString();
        STATE.game.gameOverReason = reason;
        STATE.game.finalScore = Number(global.score) || STATE.game.finalScore || 0;
        STATE.game.lastUpdatedAt = Date.now();
        try { await putGame(STATE.game); } catch (error) { console.warn('[Human log]', error); }
        setStatus(`ゲームオーバー: ${STATE.game.turnsCount}手 / 最大連鎖 ${STATE.game.maxChain}`);
        updateButtons();
    }

    async function recordEvent(type, extra = {}) {
        if (!STATE.enabled || !STATE.game) return;
        const event = {
            id: `${STATE.gameId}:event:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            gameId: STATE.gameId,
            type,
            sequence: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            turn: STATE.game.turnsCount || 0,
            board: boardSnapshot(),
            ...clone(extra)
        };
        try { await putEvent(event); } catch (error) { console.warn('[Human log]', error); }
    }

    function observeInitialization() {
        updateToggle();
        setStatus(STATE.enabled
            ? '人間ログを準備しています…'
            : 'OFF: 人間プレイは記録していません');
        updateButtons();
        void syncOnInitialization();
    }

    function csvEscape(value) {
        const text = value == null ? '' : String(value);
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function makeCsv(games, gameTurns) {
        const rows = [[
            'gameId','gameIndex','turn','thinkMs','hardDrop','mainColor','subColor',
            'x','rotation','chain','totalErased','scoreDelta','maxHeightBefore',
            'maxHeightAfter','dangerHeightBefore','dangerHeightAfter','occupiedBefore',
            'occupiedAfter','allClear','gameOver','pendingOjamaBefore','pendingOjamaAfter'
        ]];
        games.forEach((game, index) => {
            const turns = gameTurns.get(game.id) || [];
            for (const turn of turns) {
                rows.push([
                    game.id,
                    index + 1,
                    turn.turn,
                    turn.thinkMs,
                    turn.hardDrop,
                    turn.currentPair?.main ?? '',
                    turn.currentPair?.sub ?? '',
                    turn.placement?.mainX ?? '',
                    turn.placement?.rotation ?? '',
                    turn.chainCount ?? 0,
                    turn.totalErased ?? 0,
                    turn.scoreDelta ?? '',
                    maxHeight(turn.boardBefore),
                    maxHeight(turn.boardAfter),
                    dangerHeight(turn.boardBefore),
                    dangerHeight(turn.boardAfter),
                    turn.occupiedBefore ?? '',
                    turn.occupiedAfter ?? '',
                    turn.allClear ? 1 : 0,
                    turn.gameOver ? 1 : 0,
                    turn.pendingOjamaBefore ?? '',
                    turn.pendingOjamaAfter ?? ''
                ].map(csvEscape));
            }
        });
        return rows.map(row => row.join(',')).join('\n') + '\n';
    }

    function makeExportSummary(games) {
        const totalTurns = games.reduce((sum, game) => sum + (Number(game.turnsCount) || 0), 0);
        const gameOvers = games.filter(game => game.status === 'gameover').length;
        const maxChain = games.reduce((max, game) => Math.max(max, Number(game.maxChain) || 0), 0);
        return {
            schemaVersion: SCHEMA_VERSION,
            type: 'puyoAI-human-play-log-export',
            exportedAt: new Date().toISOString(),
            totalGames: games.length,
            totalTurns,
            gameOvers,
            maxChain,
            games: games.map((game, index) => ({
                archiveIndex: index + 1,
                id: game.id,
                status: game.status,
                createdAt: game.createdAt,
                startedAt: game.startedAt,
                endedAt: game.endedAt || null,
                turnsCount: game.turnsCount || 0,
                maxChain: game.maxChain || 0,
                totalChains: game.totalChains || 0,
                totalErased: game.totalErased || 0,
                finalScore: game.finalScore || 0,
                gameOverTurn: game.gameOverTurn,
                gameOverReason: game.gameOverReason
            }))
        };
    }

    async function saveBlob(blob, filename) {
        const file = typeof File === 'function'
            ? new File([blob], filename, { type: 'application/zip' })
            : null;
        if (file && typeof navigator.share === 'function') {
            let canShare = false;
            try { canShare = typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }); } catch (_) {}
            if (canShare) {
                try {
                    await navigator.share({ files: [file], title: 'PuyoAI 人間プレイログ' });
                    return;
                } catch (error) {
                    if (error?.name === 'AbortError') return;
                }
            }
        }
        if (STATE.objectUrl) {
            try { global.URL.revokeObjectURL(STATE.objectUrl); } catch (_) {}
        }
        STATE.objectUrl = global.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = STATE.objectUrl;
        link.download = filename;
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
    }

    async function exportLogs() {
        if (STATE.exporting) return;
        STATE.exporting = true;
        updateButtons();
        setExportStatus('人間ログを読み込んでいます…');
        try {
            const games = await getAllGames();
            if (!games.length) throw new Error('保存済みの人間プレイログがありません');

            const gameTurns = new Map();
            for (const game of games) {
                gameTurns.set(game.id, await getTurns(game.id));
            }
            const gameEvents = new Map();
            for (const game of games) {
                gameEvents.set(game.id, await getEvents(game.id));
            }

            const { createBenchmarkZipBuilder } = await import('./benchmark-zip.js');
            const summary = makeExportSummary(games);
            const builder = createBenchmarkZipBuilder(summary);
            await builder.appendEntry('README.txt', [
                'PuyoAI human play log archive',
                '',
                'summary.json: export-wide summary.',
                'turn_summary.csv: one row per completed human placement.',
                'game_XXXX.json: one human game, including board/NEXT/placement/chain details.',
                'events are stored separately inside each game JSON for undo/redo/reset timeline analysis.',
                'schemaVersion=1',
                'turn is a monotonic decision/attempt index; undo/redo events do not delete previous attempts.',
                ''
            ].join('\n'));
            await builder.appendEntry('summary.json', `${JSON.stringify(summary, null, 2)}\n`);
            await builder.appendEntry('turn_summary.csv', makeCsv(games, gameTurns));

            let completed = 0;
            for (let i = 0; i < games.length; i++) {
                const game = games[i];
                const payload = {
                    ...game,
                    turns: gameTurns.get(game.id) || [],
                    events: gameEvents.get(game.id) || []
                };
                await builder.appendEntry(
                    `game_${String(i + 1).padStart(4, '0')}.json`,
                    `${JSON.stringify(payload)}\n`
                );
                completed += 1;
                setExportStatus(`ZIP作成中… ${completed} / ${games.length} ゲーム`);
            }

            const blob = builder.finalize();
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
            const filename = `puyoAI-human-log-${stamp}.zip`;
            await saveBlob(blob, filename);
            setExportStatus(`ZIP保存を開始しました（${Math.round(blob.size / 1024)} KB、${games.length}ゲーム）`);
        } catch (error) {
            setExportStatus(`ZIP作成に失敗しました: ${error?.message || error}`);
            console.error('[Human log export]', error);
        } finally {
            STATE.exporting = false;
            updateButtons();
        }
    }

    async function clearLogs() {
        if (STATE.exporting) return;
        const ok = typeof global.confirm !== 'function' || global.confirm('保存済みの人間プレイログをすべて削除しますか？');
        if (!ok) return;
        try {
            const db = await openDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['games', 'turns', 'events'], 'readwrite');
                tx.objectStore('games').clear();
                tx.objectStore('turns').clear();
                tx.objectStore('events').clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error || new Error('ログ削除に失敗しました'));
                tx.onabort = () => reject(tx.error || new Error('ログ削除が中断されました'));
            });
            STATE.game = null;
            STATE.gameId = '';
            if (STATE.enabled) await beginGame('enabled-after-clear');
            else setStatus('保存済みログを削除しました');
            setExportStatus('');
        } catch (error) {
            setExportStatus(`削除に失敗しました: ${error?.message || error}`);
        }
    }

    global.toggleHumanLog = function () {
        const checkbox = document.getElementById('human-log-checkbox');
        setEnabled(!!checkbox?.checked);
    };
    global.exportHumanLogs = function () { void exportLogs(); };
    global.clearHumanLogs = function () { void clearLogs(); };

    global.humanLogOnGameInitialized = function () {
        if (!STATE.enabled) return;
        void beginGame('reset').then(observeSpawnFromGlobal);
    };

    global.humanLogObserveSpawn = function () {
        observeSpawnFromGlobal();
    };

    global.humanLogBeginTurn = beginTurn;
    global.humanLogRecordControl = recordControl;
    global.humanLogRecordPlacedBoard = recordPlacedBoard;
    global.humanLogRecordWave = recordWave;
    global.humanLogFinishTurn = function (info) { return finishTurn(info); };
    global.humanLogGameOver = function (reason) { void markGameOver(reason); };
    global.humanLogRecordEvent = function (type, extra) { void recordEvent(type, extra); };
    global.humanLogIsEnabled = function () { return !!STATE.enabled; };

    global.addEventListener('beforeunload', () => {
        if (STATE.objectUrl) {
            try { global.URL.revokeObjectURL(STATE.objectUrl); } catch (_) {}
        }
    });

    document.addEventListener('DOMContentLoaded', observeInitialization);
})(window);
