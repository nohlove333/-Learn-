(function () {
  'use strict';

  var config = window.LEARN_CONFIG || {};
  var teacherSessionKey = 'learn_teacher_session_v1';
  var studentSessionKey = 'learn_student_session_v1';

  function ApiError(message, code, details) {
    this.name = 'ApiError';
    this.message = message || '요청을 처리하지 못했습니다.';
    this.code = code || 'UNKNOWN';
    this.details = details || null;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readSession(role) {
    var key = role === 'teacher' ? teacherSessionKey : studentSessionKey;
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writeSession(role, value) {
    var key = role === 'teacher' ? teacherSessionKey : studentSessionKey;
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  function fileToPayload(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        resolve({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: result.indexOf(',') >= 0 ? result.split(',')[1] : result
        });
      };
      reader.onerror = function () {
        reject(new ApiError(file.name + ' 파일을 읽지 못했습니다.', 'FILE_READ_FAILED'));
      };
      reader.readAsDataURL(file);
    });
  }

  async function filesToPayload(files) {
    var list = Array.from(files || []);
    var maxEach = Number(config.maxFileSizeMb || 25) * 1024 * 1024;
    var maxTotal = Number(config.maxUploadSizeMb || 35) * 1024 * 1024;
    var total = list.reduce(function (sum, file) { return sum + file.size; }, 0);
    var oversized = list.find(function (file) { return file.size > maxEach; });
    if (oversized) {
      throw new ApiError(
        oversized.name + ' 파일이 ' + (config.maxFileSizeMb || 25) + 'MB를 넘습니다.',
        'FILE_TOO_LARGE'
      );
    }
    if (total > maxTotal) {
      throw new ApiError(
        '한 번에 올리는 파일의 합계는 ' + (config.maxUploadSizeMb || 35) + 'MB 이하여야 합니다.',
        'UPLOAD_TOO_LARGE'
      );
    }
    return Promise.all(list.map(fileToPayload));
  }

  function saveBase64File(file) {
    var binary = atob(file.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    var blob = new Blob([bytes], { type: file.mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name || '첨부파일';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function openBundleParts(parts, pendingWindow) {
    (parts || []).forEach(function (part, index) {
      window.setTimeout(function () {
        if (index === 0 && pendingWindow && !pendingWindow.closed) {
          pendingWindow.location.href = part.downloadUrl;
          return;
        }
        var anchor = document.createElement('a');
        anchor.href = part.downloadUrl;
        anchor.download = part.name || '';
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * 700);
    });
  }

  function AppAPI() {}

  AppAPI.prototype.request = async function (action, payload, role, retryCount) {
    if (config.demoMode) {
      await sleep(170 + Math.random() * 240);
      return DemoAPI.request(action, payload || {}, role);
    }

    if (!config.apiUrl || config.apiUrl.indexOf('PASTE_') === 0) {
      throw new ApiError('Google Apps Script 주소가 아직 설정되지 않았습니다.', 'NOT_CONFIGURED');
    }

    var session = role ? readSession(role) : null;
    var body = {
      action: action,
      payload: payload || {},
      token: session && session.token ? session.token : ''
    };
    var safeToRetry = ['teacherDashboard', 'getTeacherClass', 'getStudentClass', 'getFileContent', 'heartbeat'];
    var retries = typeof retryCount === 'number' ? retryCount : (safeToRetry.indexOf(action) >= 0 ? 2 : 0);
    try {
      var response = await fetch(config.apiUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new ApiError('서버 응답이 원활하지 않습니다.', 'HTTP_' + response.status);
      }
      var result = await response.json();
      if (!result.ok) {
        if (result.code === 'SESSION_EXPIRED' || result.code === 'UNAUTHORIZED') {
          if (role) writeSession(role, null);
        }
        throw new ApiError(result.message, result.code, result.details);
      }
      return result.data;
    } catch (error) {
      var transient = !error.code || error.code.indexOf('HTTP_5') === 0 || error.code === 'BUSY';
      if (retries > 0 && transient) {
        await sleep(600 + Math.random() * 900);
        return this.request(action, payload, role, retries - 1);
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 'NETWORK_ERROR');
    }
  };

  var demoStorageKey = 'learn_demo_database_v2';

  function createDemoState() {
    var classes = [];
    var students = [];
    var announcements = [];
    var assignments = [];
    var boards = [];
    var submissions = [];
    var boardPosts = [];
    var subjects = ['사회', '도덕', '사회', '도덕'];
    for (var c = 1; c <= 12; c += 1) {
      var classId = 'class_' + c;
      classes.push({
        id: classId,
        name: '1학년 ' + c + '반',
        subject: subjects[(c - 1) % subjects.length],
        code: 'LOVE' + String(c).padStart(2, '0'),
        school: '사랑중학교',
        studentCount: 30,
        createdAt: new Date(Date.now() - c * 86400000).toISOString()
      });
      for (var s = 1; s <= 30; s += 1) {
        students.push({
          id: classId + '_student_' + s,
          classId: classId,
          number: s,
          name: s % 5 === 0 ? '김학생' + s : '학생 ' + s,
          pin: String(1000 + ((c * 97 + s * 31) % 9000)),
          online: c === 1 && s <= 8,
          lastSeenAt: s <= 8 ? nowIso() : ''
        });
      }
      announcements.push({
        id: 'notice_' + c,
        classId: classId,
        title: c === 1 ? '이번 주 수업 준비물 안내' : '첫 수업 안내',
        body: c === 1 ? '교과서와 학습지, 필기구를 준비해 주세요.' : '우리 반 수업 공간입니다.',
        pinned: true,
        attachments: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      assignments.push({
        id: 'assignment_' + c,
        classId: classId,
        title: c === 1 ? '가족 갈등 해결 대화문' : '첫 번째 생각 기록',
        body: '수업에서 배운 내용을 바탕으로 작성해 제출하세요.',
        dueAt: new Date(Date.now() + (c + 2) * 86400000).toISOString(),
        status: 'open',
        attachments: [],
        submissionCount: c === 1 ? 18 : 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      boards.push({
        id: 'board_' + c,
        classId: classId,
        title: c === 1 ? '우리 반 생각 나눔 보드' : '첫 번째 보드',
        body: '친구의 생각을 존중하며 글과 자료를 나눠 보세요.',
        status: 'open',
        attachments: [],
        postCount: c === 1 ? 5 : 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    for (var p = 1; p <= 5; p += 1) {
      boardPosts.push({
        id: 'post_' + p,
        boardId: 'board_1',
        classId: 'class_1',
        studentId: 'class_1_student_' + p,
        studentNumber: p,
        studentName: '학생 ' + p,
        text: p === 1 ? '서로의 말을 끝까지 듣는 것이 갈등 해결의 시작이라고 생각합니다.' : '내 생각을 솔직하게 말하되 상대방을 탓하지 않겠습니다.',
        attachments: [],
        status: p === 2 ? 'revision' : 'published',
        revisionMessage: p === 2 ? '수업에서 배운 나 전달법 문장을 한 문장 덧붙여 주세요.' : '',
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    return {
      classes: classes,
      students: students,
      announcements: announcements,
      assignments: assignments,
      boards: boards,
      submissions: submissions,
      boardPosts: boardPosts
    };
  }

  function getDemoState() {
    try {
      var saved = JSON.parse(localStorage.getItem(demoStorageKey) || 'null');
      if (saved && saved.classes) return saved;
    } catch (error) {}
    var state = createDemoState();
    localStorage.setItem(demoStorageKey, JSON.stringify(state));
    return state;
  }

  function setDemoState(state) {
    localStorage.setItem(demoStorageKey, JSON.stringify(state));
  }

  function demoClassData(state, classId, studentId) {
    var classInfo = state.classes.find(function (item) { return item.id === classId; });
    if (!classInfo) throw new ApiError('클래스를 찾을 수 없습니다.', 'NOT_FOUND');
    var classStudents = state.students
      .filter(function (item) { return item.classId === classId; })
      .sort(function (a, b) { return Number(a.number) - Number(b.number); });
    return {
      classInfo: clone(classInfo),
      students: clone(classStudents),
      announcements: clone(state.announcements.filter(function (item) { return item.classId === classId; })),
      assignments: clone(state.assignments.filter(function (item) { return item.classId === classId; })),
      boards: clone(state.boards.filter(function (item) { return item.classId === classId; })),
      submissions: clone(state.submissions.filter(function (item) {
        return item.classId === classId && (!studentId || item.studentId === studentId);
      })),
      boardPosts: clone(state.boardPosts.filter(function (item) {
        return item.classId === classId;
      }).map(function (item) {
        if (!studentId || item.studentId === studentId) return item;
        return Object.assign({}, item, { status: 'published', revisionMessage: '' });
      })),
      onlineStudents: clone(classStudents.filter(function (item) { return item.online; }))
    };
  }

  var DemoAPI = {
    request: function (action, payload, role) {
      var state = getDemoState();
      var result;

      if (action === 'teacherLogin' || action === 'teacherSignup') {
        result = {
          token: 'demo_teacher_token',
          user: { id: 'teacher_demo', email: payload.email || 'teacher@example.com', name: '사랑 선생님' }
        };
        writeSession('teacher', result);
        return result;
      }

      if (action === 'studentLogin') {
        var matchedClass = state.classes.find(function (item) {
          return item.code.toLowerCase() === String(payload.classCode || '').toLowerCase();
        }) || state.classes[0];
        var matchedStudent = state.students.find(function (item) {
          return item.classId === matchedClass.id && Number(item.number) === Number(payload.number || 1);
        }) || state.students[0];
        result = {
          token: 'demo_student_' + matchedStudent.id,
          user: clone(matchedStudent),
          classInfo: clone(matchedClass)
        };
        writeSession('student', result);
        return result;
      }

      if (action === 'teacherDashboard') {
        return {
          teacher: { id: 'teacher_demo', email: 'teacher@example.com', name: '사랑 선생님' },
          classes: clone(state.classes),
          totals: {
            classes: state.classes.length,
            students: state.students.length,
            assignments: state.assignments.length,
            boards: state.boards.length
          }
        };
      }

      if (action === 'createClass') {
        if (state.classes.some(function (item) {
          return item.code.toLowerCase() === String(payload.code).toLowerCase();
        })) throw new ApiError('이미 사용 중인 클래스 코드입니다.', 'DUPLICATE_CLASS_CODE');
        var newClass = {
          id: uid('class'),
          name: payload.name,
          subject: payload.subject || '',
          school: payload.school || '',
          code: String(payload.code || '').toUpperCase(),
          studentCount: 0,
          createdAt: nowIso()
        };
        state.classes.unshift(newClass);
        setDemoState(state);
        return clone(newClass);
      }

      if (action === 'deleteClass') {
        var targetClass = state.classes.find(function (item) { return item.id === payload.classId; });
        if (!targetClass || targetClass.code !== String(payload.confirmCode || '').toUpperCase()) {
          throw new ApiError('클래스 코드가 일치하지 않습니다.', 'CLASS_CODE_MISMATCH');
        }
        state.classes = state.classes.filter(function (item) { return item.id !== payload.classId; });
        ['students', 'announcements', 'assignments', 'boards', 'submissions', 'boardPosts'].forEach(function (key) {
          state[key] = state[key].filter(function (item) { return item.classId !== payload.classId; });
        });
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'getTeacherClass') {
        return demoClassData(state, payload.classId);
      }

      if (action === 'getStudentClass') {
        var studentSession = readSession('student');
        if (!studentSession) throw new ApiError('학생 로그인이 필요합니다.', 'UNAUTHORIZED');
        return demoClassData(state, studentSession.classInfo.id, studentSession.user.id);
      }

      if (action === 'upsertContent') {
        var tableMap = { announcement: 'announcements', assignment: 'assignments', board: 'boards' };
        var table = tableMap[payload.type];
        if (!table) throw new ApiError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
        var existing = state[table].find(function (item) { return item.id === payload.id; });
        if (existing) {
          Object.assign(existing, payload.data, { updatedAt: nowIso() });
          result = existing;
        } else {
          result = Object.assign({
            id: uid(payload.type),
            classId: payload.classId,
            attachments: [],
            createdAt: nowIso(),
            updatedAt: nowIso()
          }, payload.data);
          state[table].unshift(result);
        }
        setDemoState(state);
        return clone(result);
      }

      if (action === 'deleteContent') {
        var deleteMap = { announcement: 'announcements', assignment: 'assignments', board: 'boards' };
        var deleteTable = deleteMap[payload.type];
        state[deleteTable] = state[deleteTable].filter(function (item) { return item.id !== payload.id; });
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'addStudents') {
        var start = Number(payload.startNumber || 1);
        var count = Number(payload.count || 30);
        var names = payload.names || [];
        var created = [];
        for (var n = 0; n < count; n += 1) {
          var number = start + n;
          if (state.students.some(function (item) {
            return item.classId === payload.classId && Number(item.number) === number;
          })) continue;
          var student = {
            id: uid('student'),
            classId: payload.classId,
            number: number,
            name: names[n] || '학생 ' + number,
            pin: String(Math.floor(1000 + Math.random() * 9000)),
            online: false,
            lastSeenAt: ''
          };
          state.students.push(student);
          created.push(student);
        }
        var classRow = state.classes.find(function (item) { return item.id === payload.classId; });
        if (classRow) {
          classRow.studentCount = state.students.filter(function (item) { return item.classId === payload.classId; }).length;
        }
        setDemoState(state);
        return { students: clone(created) };
      }

      if (action === 'resetStudentPin') {
        var resetStudent = state.students.find(function (item) { return item.id === payload.studentId; });
        if (!resetStudent) throw new ApiError('학생을 찾을 수 없습니다.', 'NOT_FOUND');
        resetStudent.pin = String(Math.floor(1000 + Math.random() * 9000));
        setDemoState(state);
        return { studentId: resetStudent.id, pin: resetStudent.pin };
      }

      if (action === 'deleteStudent') {
        state.students = state.students.filter(function (item) { return item.id !== payload.studentId; });
        state.submissions = state.submissions.filter(function (item) { return item.studentId !== payload.studentId; });
        state.boardPosts = state.boardPosts.filter(function (item) { return item.studentId !== payload.studentId; });
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'upsertSubmission') {
        var ss = readSession('student');
        var submission = state.submissions.find(function (item) {
          return item.assignmentId === payload.assignmentId && item.studentId === ss.user.id;
        });
        if (submission) {
          submission.text = payload.text || '';
          submission.updatedAt = nowIso();
        } else {
          submission = {
            id: uid('submission'),
            assignmentId: payload.assignmentId,
            classId: ss.classInfo.id,
            studentId: ss.user.id,
            studentNumber: ss.user.number,
            studentName: ss.user.name,
            text: payload.text || '',
            attachments: [],
            submittedAt: nowIso(),
            updatedAt: nowIso()
          };
          state.submissions.push(submission);
        }
        setDemoState(state);
        return clone(submission);
      }

      if (action === 'deleteSubmission') {
        var ds = readSession('student');
        state.submissions = state.submissions.filter(function (item) {
          return !(item.assignmentId === payload.assignmentId && item.studentId === ds.user.id);
        });
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'upsertBoardPost') {
        var bs = readSession('student');
        var post = state.boardPosts.find(function (item) {
          return item.boardId === payload.boardId && item.studentId === bs.user.id;
        });
        if (post) {
          post.text = payload.text || '';
          post.status = 'published';
          post.revisionMessage = '';
          post.updatedAt = nowIso();
        } else {
          post = {
            id: uid('post'),
            boardId: payload.boardId,
            classId: bs.classInfo.id,
            studentId: bs.user.id,
            studentNumber: bs.user.number,
            studentName: bs.user.name,
            text: payload.text || '',
            attachments: [],
            status: 'published',
            revisionMessage: '',
            createdAt: nowIso(),
            updatedAt: nowIso()
          };
          state.boardPosts.push(post);
        }
        setDemoState(state);
        return clone(post);
      }

      if (action === 'deleteBoardPost') {
        state.boardPosts = state.boardPosts.filter(function (item) { return item.id !== payload.postId; });
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'reviewBoardPost') {
        var reviewed = state.boardPosts.find(function (item) { return item.id === payload.postId; });
        if (!reviewed) throw new ApiError('게시물을 찾을 수 없습니다.', 'NOT_FOUND');
        var reviewDecision = String(payload.decision || (payload.message ? 'revision' : 'published'));
        if (['revision', 'confirmed', 'published'].indexOf(reviewDecision) < 0) {
          throw new ApiError('게시글 확인 상태가 올바르지 않습니다.', 'INVALID_REVIEW');
        }
        reviewed.status = reviewDecision;
        reviewed.revisionMessage = '';
        reviewed.updatedAt = nowIso();
        setDemoState(state);
        return clone(reviewed);
      }

      if (action === 'createDownloadBundle') {
        var sample = btoa(unescape(encodeURIComponent('미리보기 모드의 일괄 다운로드 예시 파일입니다.')));
        return {
          parts: [{
            name: (payload.title || '과제') + '_전체.zip',
            downloadUrl: 'data:text/plain;base64,' + sample
          }],
          fileCount: 0,
          demo: true
        };
      }

      if (action === 'getFileContent') {
        return { name: '첨부파일.txt', mimeType: 'text/plain', data: btoa('demo') };
      }

      if (action === 'heartbeat') {
        return { onlineStudents: [] };
      }

      throw new ApiError('미리보기 모드에서 지원하지 않는 요청입니다: ' + action, 'DEMO_NOT_IMPLEMENTED');
    }
  };

  window.LearnAPI = new AppAPI();
  window.LearnFiles = {
    toPayload: filesToPayload,
    saveBase64: saveBase64File,
    openBundleParts: openBundleParts
  };
  window.LearnSession = {
    get: readSession,
    set: writeSession,
    clear: function (role) { writeSession(role, null); }
  };
  window.LearnApiError = ApiError;
})();
