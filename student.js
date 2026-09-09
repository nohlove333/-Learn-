(function () {
  'use strict';

  var UI = window.LearnUI;
  var API = window.LearnAPI;
  var studentData = null;
  var selectedBoards = {};
  var heartbeatTimer = null;

  function sessionOrLogin() {
    var session = window.LearnSession.get('student');
    if (!session || !session.token) {
      location.hash = '#/student/login';
      return null;
    }
    return session;
  }

  function loading(container) {
    container.innerHTML = '<section class="loading-screen"><div class="loader"></div><p>우리 반 자료를 불러오고 있어요.</p></section>';
  }

  async function renderClass(container, tab) {
    var session = sessionOrLogin();
    if (!session) return;
    stopHeartbeat();
    var safeTab = ['announcements', 'assignments', 'boards'].indexOf(tab) >= 0 ? tab : 'announcements';
    loading(container);
    try {
      studentData = await API.request('getStudentClass', {}, 'student');
      paintClass(container, safeTab, session);
      startHeartbeat(studentData.classInfo.id);
    } catch (error) {
      container.innerHTML = '<section class="page"><div class="panel">' +
        UI.empty('자료를 불러오지 못했어요', error.message || '잠시 후 다시 시도해 주세요.',
          '<button class="button" type="button" data-retry>다시 시도</button>') + '</div></section>';
      container.querySelector('[data-retry]').addEventListener('click', function () { renderClass(container, safeTab); });
    }
  }

  function paintClass(container, tab, session) {
    var classId = studentData.classInfo.id;
    container.innerHTML =
      '<section class="app-page">' +
        '<header class="workspace-head">' +
          '<div class="workspace-title-wrap"><div class="back-button" aria-hidden="true">' + UI.escape(session.user.number) + '</div>' +
            '<div><h1>' + UI.escape(studentData.classInfo.name) + '</h1>' +
              '<p>' + UI.escape(session.user.name) + ' · ' + UI.escape(studentData.classInfo.subject || '수업') + '</p></div></div>' +
          '<div class="inline-actions"><button class="button secondary small" type="button" data-refresh>새로고침</button>' +
            '<button class="button small" type="button" data-student-logout>나가기</button></div>' +
        '</header>' +
        '<nav class="tab-bar" aria-label="우리 반 메뉴">' +
          studentTab('announcements', '공지', studentData.announcements.length, tab) +
          studentTab('assignments', '과제', studentData.assignments.length, tab) +
          studentTab('boards', '보드', studentData.boards.length, tab) +
        '</nav>' +
        '<section class="panel content-panel">' + renderTab(tab, session) + '</section>' +
      '</section>';
    container.querySelector('[data-refresh]').addEventListener('click', function () { renderClass(container, tab); });
    container.querySelector('[data-student-logout]').addEventListener('click', function () {
      window.LearnSession.clear('student');
      location.hash = '#/';
    });
    bindTabActions(container, tab, session);
    UI.bindFiles(container, 'student');
  }

  function studentTab(key, label, count, active) {
    return '<a class="tab-button ' + (key === active ? 'active' : '') + '" href="#/student/class/' + key + '">' +
      UI.escape(label) + '<span class="tab-count">' + UI.escape(count) + '</span></a>';
  }

  function renderTab(tab, session) {
    if (tab === 'assignments') return renderAssignments(session);
    if (tab === 'boards') return renderBoards(session);
    return renderAnnouncements();
  }

  function renderAnnouncements() {
    var items = studentData.announcements.slice().sort(function (a, b) {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    var head = '<div class="content-head"><div><h2>공지</h2><p>선생님이 전한 수업 소식을 확인하세요.</p></div></div>';
    if (!items.length) return head + UI.empty('새 공지가 없어요', '새로운 공지가 등록되면 이곳에 표시됩니다.');
    return head + '<div class="item-list">' + items.map(function (item) {
      return '<article class="item-card ' + (item.pinned ? 'pinned' : '') + '">' +
        '<div class="item-top"><div><h3>' + UI.escape(item.title) + '</h3>' +
          '<div class="meta-line">' + (item.pinned ? '<span class="status-badge">중요 공지</span>' : '') +
            '<span>' + UI.escape(UI.date(item.updatedAt, true)) + '</span></div></div></div>' +
        (item.body ? '<p class="item-body">' + UI.escape(item.body) + '</p>' : '') +
        UI.attachments(item.attachments, 'student') + '</article>';
    }).join('') + '</div>';
  }

  function renderAssignments(session) {
    var own = {};
    studentData.submissions.forEach(function (submission) { own[submission.assignmentId] = submission; });
    var head = '<div class="content-head"><div><h2>과제</h2><p>제출 내용과 파일은 선생님과 나만 볼 수 있어요.</p></div></div>';
    if (!studentData.assignments.length) return head + UI.empty('등록된 과제가 없어요', '새 과제가 등록되면 이곳에 표시됩니다.');
    return head + '<div class="item-list">' + studentData.assignments.map(function (assignment) {
      var submission = own[assignment.id];
      var open = assignment.status === 'open';
      return '<article class="item-card">' +
        '<div class="item-top"><div><h3>' + UI.escape(assignment.title) + '</h3>' +
          '<div class="meta-line"><span class="status-badge ' + (open ? 'open' : '') + '">' + (open ? '제출 가능' : '마감') + '</span>' +
            (assignment.dueAt ? '<span>마감 ' + UI.escape(UI.date(assignment.dueAt, true)) + '</span>' : '') +
          '</div></div>' +
          '<button class="button ' + (submission ? 'secondary' : '') + ' small" type="button" data-submit-assignment="' +
            UI.attr(assignment.id) + '" ' + (!open ? 'disabled' : '') + '>' + (submission ? '제출 수정' : '제출하기') + '</button></div>' +
        (assignment.body ? '<p class="item-body">' + UI.escape(assignment.body) + '</p>' : '') +
        UI.attachments(assignment.attachments, 'student') +
        (submission ? submissionBox(submission, assignment, open) : '') +
      '</article>';
    }).join('') + '</div>';
  }

  function submissionBox(submission, assignment, open) {
    return '<div class="submission-card"><div class="item-top"><div><strong>내 제출물</strong>' +
      '<div class="meta-line"><span>제출 ' + UI.escape(UI.date(submission.submittedAt, true)) + '</span>' +
        (submission.updatedAt !== submission.submittedAt ? '<span>수정 ' + UI.escape(UI.date(submission.updatedAt, true)) + '</span>' : '') +
      '</div></div><div class="inline-actions">' +
        (open ? '<button class="text-link" type="button" data-delete-submission="' + UI.attr(assignment.id) + '">제출 삭제</button>' : '') +
      '</div></div>' +
      (submission.text ? '<p class="item-body">' + UI.escape(submission.text) + '</p>' : '') +
      UI.attachments(submission.attachments, 'student') + '</div>';
  }

  function renderBoards(session) {
    var classId = studentData.classInfo.id;
    var boards = studentData.boards;
    var head = '<div class="content-head"><div><h2>우리 반 보드</h2><p>친구의 생각을 읽고, 내 출석번호 카드에 글과 파일을 올려 보세요.</p></div></div>';
    if (!boards.length) return head + UI.empty('열린 보드가 없어요', '선생님이 보드를 만들면 이곳에 표시됩니다.');
    var chosenId = selectedBoards[classId];
    if (!chosenId || !boards.some(function (board) { return board.id === chosenId; })) chosenId = boards[0].id;
    selectedBoards[classId] = chosenId;
    var board = boards.find(function (item) { return item.id === chosenId; });
    var posts = studentData.boardPosts.filter(function (post) { return post.boardId === chosenId; });
    var byStudent = {};
    posts.forEach(function (post) { byStudent[post.studentId] = post; });
    var selectors = boards.length > 1
      ? '<div class="toolbar" style="margin-bottom:20px">' + boards.map(function (item) {
          return '<button class="button small ' + (item.id === chosenId ? '' : 'secondary') + '" type="button" data-select-board="' +
            UI.attr(item.id) + '">' + UI.escape(item.title) + '</button>';
        }).join('') + '</div>'
      : '';
    var cards = studentData.students.map(function (student) {
      var post = byStudent[student.id];
      var mine = student.id === session.user.id;
      return '<article class="student-tile ' + (mine ? 'mine' : '') + '" tabindex="' + (post || mine ? '0' : '-1') +
        '" data-student-card="' + UI.attr(student.id) + '" data-post-id="' + UI.attr(post ? post.id : '') + '">' +
        '<div><span class="tile-number">' + UI.escape(student.number) + '</span><span class="tile-name">' +
          UI.escape(student.name) + (mine ? ' · 나' : '') + '</span></div>' +
        (post
          ? '<div class="tile-content">' + UI.escape((post.text || '첨부파일을 올렸어요.').slice(0, 92)) +
            (post.text && post.text.length > 92 ? '…' : '') + '</div>' +
            (post.attachments && post.attachments.length ? '<div class="meta-line"><span>첨부 ' + post.attachments.length + '개</span></div>' : '') +
            (post.status === 'revision' ? '<div class="revision-note" style="padding:7px;margin-top:10px">선생님의 수정 요청이 있어요.</div>' : '')
          : mine && board.status === 'open'
            ? '<div class="tile-empty"><span class="tile-plus">＋</span>내 카드에 작성하기</div>'
            : '<div class="tile-empty">아직 작성하지 않았어요.</div>') +
      '</article>';
    }).join('');
    return head + selectors +
      '<article class="item-card" style="margin-bottom:20px"><div class="item-top"><div><h3>' + UI.escape(board.title) + '</h3>' +
        '<div class="meta-line"><span class="status-badge ' + (board.status === 'open' ? 'open' : '') + '">' +
          (board.status === 'open' ? '작성 가능' : '읽기 전용') + '</span><span>게시 ' + posts.length + '/' + studentData.students.length + '명</span></div></div></div>' +
        (board.body ? '<p class="item-body">' + UI.escape(board.body) + '</p>' : '') + UI.attachments(board.attachments, 'student') + '</article>' +
      '<div class="board-grid">' + cards + '</div>';
  }

  function bindTabActions(container, tab, session) {
    container.querySelectorAll('[data-submit-assignment]').forEach(function (button) {
      button.addEventListener('click', function () {
        var assignment = studentData.assignments.find(function (item) { return item.id === button.dataset.submitAssignment; });
        var submission = studentData.submissions.find(function (item) { return item.assignmentId === assignment.id; });
        openSubmissionEditor(assignment, submission, container, tab);
      });
    });
    container.querySelectorAll('[data-delete-submission]').forEach(function (button) {
      button.addEventListener('click', function () { deleteSubmission(button.dataset.deleteSubmission, container, tab); });
    });
    container.querySelectorAll('[data-select-board]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectedBoards[studentData.classInfo.id] = button.dataset.selectBoard;
        paintClass(container, tab, session);
      });
    });
    container.querySelectorAll('[data-student-card]').forEach(function (tile) {
      function activate() {
        var mine = tile.dataset.studentCard === session.user.id;
        var boardId = selectedBoards[studentData.classInfo.id];
        var board = studentData.boards.find(function (item) { return item.id === boardId; });
        var post = studentData.boardPosts.find(function (item) { return item.id === tile.dataset.postId; });
        if (mine && board.status === 'open') {
          openBoardEditor(board, post, container, tab);
        } else if (post) {
          openBoardPost(post, board, mine, container, tab);
        }
      }
      tile.addEventListener('click', activate);
      tile.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });
  }

  function uploadFields(existing, textValue, label) {
    return '<div class="field"><label for="student-text">' + UI.escape(label) + '</label>' +
      '<textarea id="student-text" name="text" maxlength="5000" placeholder="내용을 입력하세요.">' + UI.escape(textValue || '') + '</textarea></div>' +
      '<div class="field"><span class="field-label">첨부파일</span>' +
        '<label class="file-drop" data-file-drop><input type="file" multiple data-file-input>' +
          '<strong>파일을 끌어놓거나 눌러서 선택</strong><span>이미지, 영상, PDF, Word 등 · 파일당 최대 ' +
            UI.escape((window.LEARN_CONFIG || {}).maxFileSizeMb || 25) + 'MB</span></label>' +
        '<div class="selected-files" data-selected-files></div></div>';
  }

  function openSubmissionEditor(assignment, submission, container, tab) {
    var dialog = UI.modal({
      title: assignment.title + (submission ? ' 수정' : ' 제출'),
      html:
        '<form class="form-stack" data-submission-form>' +
          '<div class="info-box">제출한 내용과 파일은 선생님과 나만 확인할 수 있어요.</div>' +
          uploadFields(submission ? submission.attachments : [], submission ? submission.text : '', '제출 내용') +
          '<div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button>' +
            '<button class="button" type="submit">' + (submission ? '수정해서 제출' : '제출하기') + '</button></div>' +
        '</form>'
    });
    var picker = UI.filePicker(dialog, submission ? submission.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-submission-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var text = String(new FormData(form).get('text') || '').trim();
      if (!text && !picker.files().length && !picker.keepAttachmentIds().length) {
        UI.toast('내용이나 파일을 하나 이상 제출해 주세요.', 'error');
        return;
      }
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '제출 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertSubmission', {
          assignmentId: assignment.id,
          text: text,
          files: files,
          keepAttachmentIds: picker.keepAttachmentIds()
        }, 'student', 0);
        UI.closeModal();
        UI.toast(submission ? '제출물을 수정했습니다.' : '과제를 제출했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  async function deleteSubmission(assignmentId, container, tab) {
    var yes = await UI.confirm({
      title: '제출물 삭제',
      message: '작성한 내용과 첨부파일이 모두 삭제됩니다.',
      confirmText: '제출 삭제',
      danger: true
    });
    if (!yes) return;
    try {
      await API.request('deleteSubmission', { assignmentId: assignmentId }, 'student');
      UI.toast('제출물을 삭제했습니다.');
      renderClass(container, tab);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  function openBoardEditor(board, post, container, tab) {
    var dialog = UI.modal({
      title: board.title + ' · 내 카드',
      html:
        (post && post.status === 'revision' ? '<div class="revision-note"><strong>선생님의 수정 요청</strong><br>' +
          UI.escape(post.revisionMessage) + '</div>' : '') +
        '<form class="form-stack" data-board-form style="margin-top:16px">' +
          uploadFields(post ? post.attachments : [], post ? post.text : '', '게시글 내용') +
          '<div class="modal-actions">' +
            (post ? '<button class="button danger" type="button" data-delete-my-post>내 글 삭제</button>' : '') +
            '<button class="button secondary" type="button" data-cancel>취소</button>' +
            '<button class="button" type="submit">' + (post ? '수정해서 게시' : '게시하기') + '</button></div>' +
        '</form>'
    });
    var picker = UI.filePicker(dialog, post ? post.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-board-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var text = String(new FormData(form).get('text') || '').trim();
      if (!text && !picker.files().length && !picker.keepAttachmentIds().length) {
        UI.toast('내용이나 파일을 하나 이상 게시해 주세요.', 'error');
        return;
      }
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '게시 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertBoardPost', {
          boardId: board.id,
          text: text,
          files: files,
          keepAttachmentIds: picker.keepAttachmentIds()
        }, 'student', 0);
        UI.closeModal();
        UI.toast(post ? '게시글을 수정했습니다.' : '내 카드에 게시했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
    var deleteButton = dialog.querySelector('[data-delete-my-post]');
    if (deleteButton) deleteButton.addEventListener('click', async function () {
      var yes = await UI.confirm({
        title: '내 게시글 삭제',
        message: '내용과 첨부파일이 모두 삭제됩니다.',
        confirmText: '삭제',
        danger: true
      });
      if (!yes) return;
      try {
        await API.request('deleteBoardPost', { postId: post.id }, 'student');
        UI.closeModal();
        UI.toast('게시글을 삭제했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
      }
    });
  }

  function openBoardPost(post, board, mine, container, tab) {
    var dialog = UI.modal({
      title: post.studentNumber + '번 ' + post.studentName,
      wide: true,
      html:
        '<div class="meta-line"><span>게시 ' + UI.escape(UI.date(post.createdAt, true)) + '</span>' +
          (post.updatedAt !== post.createdAt ? '<span>수정 ' + UI.escape(UI.date(post.updatedAt, true)) + '</span>' : '') +
        '</div>' +
        '<p class="item-body" style="font-size:1.05rem;margin-top:22px">' + UI.escape(post.text || '') + '</p>' +
        UI.attachments(post.attachments, 'student') +
        (mine && board.status === 'open' ? '<div class="modal-actions"><button class="button" type="button" data-edit-my-post>내 글 수정</button></div>' : '')
    });
    UI.bindFiles(dialog, 'student');
    var edit = dialog.querySelector('[data-edit-my-post]');
    if (edit) edit.addEventListener('click', function () { openBoardEditor(board, post, container, tab); });
  }

  function startHeartbeat(classId) {
    stopHeartbeat();
    function beat() {
      API.request('heartbeat', { classId: classId }, 'student', 1).catch(function () {});
    }
    beat();
    heartbeatTimer = window.setInterval(beat, 45000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  window.StudentViews = {
    classPage: renderClass,
    stop: stopHeartbeat
  };
})();
