/** Small dependency-free helpers shared by the Telegram Mini App and tests. */

/** Decline Russian nouns correctly: 1 изделие, 2 изделия, 5 изделий. */
export function productCountLabel(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return "Количество уточняется";
  const tail100 = count % 100;
  const tail10 = count % 10;
  const noun = tail100 >= 11 && tail100 <= 14
    ? "изделий"
    : tail10 === 1 ? "изделие"
    : tail10 >= 2 && tail10 <= 4 ? "изделия"
    : "изделий";
  return count + " " + noun;
}

/** Native Telegram back button returns to the catalogue, not out of the app. */
export function syncTelegramBackButton(webApp, view) {
  const back = webApp?.BackButton;
  if (!back) return;
  try {
    if (view === "catalog") back.hide?.();
    else back.show?.();
  } catch {
    // Older Telegram clients may not implement the full BackButton API.
  }
}

export function configureTelegramBackNavigation(webApp, navigate) {
  const back = webApp?.BackButton;
  if (!back || typeof back.onClick !== "function") return false;
  try {
    back.onClick(() => navigate("catalog"));
    return true;
  } catch {
    return false;
  }
}
