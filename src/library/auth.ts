// 단일 비밀번호 기반 라이브러리 인증.
//
// 첫 진입 시 모달로 비번 입력 → /api/list 호출로 검증 → 통과 시 localStorage 저장.
// 이후 모든 API 호출은 X-Studio-Token 헤더로 비번 전달.

const KEY = 'studio:library:token';

export function getToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setToken(t: string): void {
  try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

/** 토큰 검증 — /api/list 호출해서 401 이면 false. */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const r = await fetch('/api/list?category=maps', {
      headers: { 'x-studio-token': token },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Chrome 의 password manager 가 페이지 안 다른 텍스트 input 들을 username
 *  필드로 오인해서 "비밀번호 저장하시겠습니까?" 를 띄우는 것을 막기 위해,
 *  인증이 끝났거나 필요 없으면 #auth-modal 전체를 DOM 에서 제거. */
function removeAuthModalFromDom(): void {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.remove();
}

/** 비번 모달 띄우고 정상 로그인 시 토큰 저장 + resolve. */
export function promptAuth(): Promise<string> {
  return new Promise((resolve) => {
    const modal = document.getElementById('auth-modal')!;
    const input = document.getElementById('auth-input') as HTMLInputElement;
    const submit = document.getElementById('auth-submit') as HTMLButtonElement;
    const err = document.getElementById('auth-error')!;

    modal.classList.remove('hidden');
    input.value = '';
    err.classList.add('hidden');
    setTimeout(() => input.focus(), 50);

    const submitOnce = async () => {
      const v = input.value.trim();
      if (!v) return;
      submit.disabled = true;
      submit.textContent = '...';
      const ok = await verifyToken(v);
      submit.disabled = false;
      submit.textContent = '입장';
      if (ok) {
        setToken(v);
        removeAuthModalFromDom();
        resolve(v);
      } else {
        err.textContent = '비밀번호가 다르거나 서버 응답 실패';
        err.classList.remove('hidden');
        input.select();
      }
    };
    submit.onclick = submitOnce;
    input.onkeydown = (e) => { if (e.key === 'Enter') submitOnce(); };
  });
}

/** 보장된 토큰을 반환 — 없으면 모달 띄움. 검증된 적 있는 토큰은 재검증 안 함 (빠른 부팅). */
export async function ensureAuth(): Promise<string> {
  const cached = getToken();
  if (cached) {
    removeAuthModalFromDom();
    return cached;
  }
  return promptAuth();
}
