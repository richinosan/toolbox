/** ？ボタンで表示する技術仕様。該当しない項目も省略せず「なし」と書く。 */
export type TechSpec = {
  /** 動作の概要（どこで何を処理するか） */
  overview: string;
  /** ネットワーク通信の有無と内容 */
  network: string;
  /** localStorage / Cookie などに保存される情報 */
  storage: string;
  /** 使用している主なライブラリ */
  libraries: readonly string[];
};

/** チュートリアル（コーチマーク）の 1 ステップ */
export type TourStep = {
  /** 強調する要素の CSS セレクター（見つからないステップは飛ばす） */
  target: string;
  title: string;
  body: string;
};
