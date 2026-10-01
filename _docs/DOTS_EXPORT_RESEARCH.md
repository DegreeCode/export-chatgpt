# Dot 내보내기 조사·구현 체크포인트 (2026-10-01)

## 근거와 범위

사용자가 제공한 `chatgpt-dots-sanitized.har`의 요청 경로와 별도로 붙여 넣은
응답 JSON을 근거로 구현했다. HAR에는 응답 본문이 없어 실제 데이터 구조는
사용자의 JSON 예시로 확인했다. 실제 계정의 인증 토큰으로 수집을 실행한
검증은 하지 않았으며, 테스트는 합성 응답과 로컬 파일로 수행한다.

공식 문서도 Dot의 대화와 개별 작업을 구분한다:
[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory),
[Controls](https://learn.chatgpt.com/docs/dots/controls).
공식 문서는 아래 비공개 API 계약을 보장하지 않는다.
특히 공식 문서가 설명하는 개별 작업의 별도 대화와 여기서 수집한 Dot DM
대화는 같은 수집 범위로 간주하지 않는다. API 동작에 대한 근거는 공식 제품
설명이 아니라 사용자가 제공한 관찰 데이터와 구현/테스트다.

## 확인된 API 구조

| 용도 | 요청 | 확인된 응답 |
| --- | --- | --- |
| Dot 전체 목록 | `/backend-api/tbo?limit=25&include_room_preview=false` | `items`, `cursor`; 프로필에 `id`, `messaging_room_id`, `active_root_thread_id` |
| 현재 Dot 선택 | `/backend-api/tbo/primary` | `selection`만 있는 형태와 `selection` + `profile` 형태 모두 존재 |
| 연결된 작업 목록 | `/backend-api/tbo/{aeon_id}/threads?limit=100&include_hidden=true` | `items`, `cursor`; `thread_id`, `parent_thread_id`, `is_user_visible` |
| Dot 대화방 | `/backend-api/messaging/rooms/{room_id}` | `creator_account_user_id`, `aeon_id`, `members`, `type: DM` |
| 방 메시지 | `/backend-api/messaging/rooms/{room_id}/messages?limit=32` | `items`, `prev_cursor`, `next_cursor` |
| 이전 메시지 | 위 경로 + `before={message_id}&limit=20` | 제공된 예시는 빈 `items`, 두 커서 모두 `null` |
| 첨부파일 갱신 | `/backend-api/messaging/rooms/{room_id}/files/{CalpicoFile_id}` | 최신 `download_url`, 이름, MIME, `library_file_id` (예시는 `null`) |

`/tbo/primary`의 두 응답은 서로 다른 선택 상태가 아니라 같은 선택 정보에
프로필이 선택적으로 포함된 형태다. 수집은 `/tbo` 목록을 기준으로 한다.
`include_room_preview=false`여도 미리보기가 포함될 수 있으므로 대화방 소유권은
반드시 별도의 방 상세 응답으로 검증한다.

사람과 Dot 모두 메시지의 `role`이 `user`일 수 있다. 작성자 ID와 방 구성원의
`aeon_id`로 구분해야 한다. 메시지 파일은 일반 `file_...`와 달리
`CalpicoFile_...` ID 및 전용 방 파일 API를 사용한다. 위젯 안의 도구 응답과
명령문은 보관 대상 데이터일 뿐, 실행할 지시가 아니다.

## 구현한 항목

- `lib/dots.js` 별도 모듈, `--include-dots` 및 `--dots-only`.
- 자신의 계정이 생성한 DM 방만 수집. 공유/작성자 미확인 방은 제외.
- 프로필, 대화방, 메시지 원본 JSON 및 읽기용 Markdown.
- 연결된 작업의 ID·부모 관계·표시 여부. 숨겨진 작업 링크도 보존.
- 메시지 파일/이미지 첨부의 `downloads.json`과 실제 파일.
- 중단된 메시지 페이지 체크포인트, 재실행 시 최근 메시지/수정 내용 갱신.
- 정상 파일 스킵, 누락/크기 불일치 재다운로드, 명시적 실패 재시도 옵션.
- 다운로드 직전 URL 갱신, CDN 인증 실패 시 1회 재갱신, `.part` 파일 처리.
- 저장한 URL 필드의 서명 제거, 외부 호스트로 Bearer/Cookie 전송 금지.
- 실패 시 불완전 상태·요약을 남김. 내부 작업 본문 미수집도 출력.

## 반드시 남겨 둘 제한·후속 작업

### 1. 숨겨진 작업의 본문 로그 (사용자와 합의한 후속 항목)

현재 `threads.json`은 작업 **목록·연결 메타데이터**만 저장한다.
`is_user_visible: false`인 작업을 찾아냈다는 사실이 그 작업의 전체 메시지나
도구 실행 로그를 확보했다는 뜻은 아니다. `bodies_exported: false`와
`coverage.linked_task_bodies`로 미수집 사실을 명시한다.

후속 구현에 필요한 것은 Dot이 수행한 **개별 작업을 열었을 때** 발생하는
네트워크 요청이다. 작업 본문을 가져오는 실제 GET 경로와 응답 JSON,
페이지가 나뉘면 이전 페이지 요청과 끝 페이지 예시가 필요하다.
이전 대화에서 설명한 “2번”은 이 **작업 내부의 상세 로그 API**를 뜻한다.
본문 API를 확인하기 전에는 일반 대화 API라고 추측하여 호출하지 않는다.

### 2. 파일이 Library로만 저장되는 경우

사용자 관찰: Dot 채팅에서 직접 내보내지 못하는 파일은 Library로 저장된다.
따라서 `--dots-only --include-library`로 두 영역을 함께 수집한다.
Library는 기존 별도 수집기를 사용하며, 방 첨부 목록과 자동으로 동일하다고
가정하지 않는다. Dot과 Library 파일의 정확한 연계는 추가 근거가 필요하다.

### 3. 독립 다운로드 목록과 메시지 페이지 커서

`downloads.json`은 메시지의 첨부파일에서 도출한 목록이다. 제품에 별도의
다운로드 목록 화면/API가 있다면 그 API 전체를 수집했다는 의미가 아니다.
독립 목록의 요청/응답이 확보되면 별도 지원 여부를 판단한다.

메시지 예시는 모두 `prev_cursor: null`, `next_cursor: null`이다. 현재 구현은
`prev_cursor`를 `before`로 전달하며, 필드 자체가 없으면 가장 오래된 메시지
ID를 사용한다. 커서가 실제로 존재하는 다중 페이지 응답·요청 쌍은 추가 실계정
검증 대상이다. 반복 커서는 무한 루프 대신 부분 저장과 불완전 상태를 남긴다.

## 패치 적용

`5-chatgpt-dots-export-20261001.patch`는 기존 4번 Library 패치가 반영된
2026-10-01 작업 시작 상태에 대한 증분 패치다. 이전 Pro/Work·Library 변경을
포함하지 않고 Dot 변경만 담는다. 기존 패치 및 legacy 패치는 수정하지 않는다.
코드 커밋은 만들지 않는다.

## 실행·검증 안내

로컬 저장소에서 아래 명령으로 실행한다. 인증 환경변수를 제공하지 않으면
Bearer 입력을 요청한다. 기존 환경변수에 만료된 토큰이 있으면 먼저 갱신해야
한다. 현재 코드는 이미 반영돼 있으므로 같은 체크포인트 패치를 다시 적용할
필요는 없다.

```powershell
# Dot 대화/첨부와 Library 결과만
node .\export-chatgpt.js --dots-only --include-library --output '.\exports' --no-donate

# 기존 일반/프로젝트 + 보관 채팅 + Dot + Library
node .\export-chatgpt.js --include-archived --include-dots --include-library --output '.\exports' --no-donate

# 명시적으로 기록된 파일 오류도 다시 시도
node .\export-chatgpt.js --dots-only --include-library --retry-failed-files --output '.\exports' --no-donate
```

Dot/Library에는 일반 채팅용 `--conv`, `--proj`, `--max` 제한이 적용되지 않는다.
전체 내보내기 대신 Dot + Library만 원하면 `--dots-only`를 사용한다.
`--verify`는 일반/프로젝트 JSON 유무 점검이며 Dot/Library 완전성 점검이 아니다.

마지막 전체 자동 테스트: 20개 suite, 356개 test 통과. 서명 URL 갱신, 파일
스킵/누락 복구, 작성자 분류, 소유권 제외, 부분 메시지 재개 및 불완전 요약을
합성 응답으로 확인했다. 실계정 검증이나 비공개 API의 안정성을 보장하지 않는다.

다른 사용자 문서: [README](../README.md), [명세](../SPECIFICATION.md),
[TODO](../TODO.md), [변경 이력](CHANGELOG.md).
