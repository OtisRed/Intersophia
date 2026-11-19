const copyInvite = document.getElementById("copy-invite");
copyInvite.addEventListener("click", async () => {
  const link = document.getElementById("invite-link");
  const status = document.getElementById("copy-result");
  try {
    await navigator.clipboard.writeText(link.value);
    status.textContent = "Link skopiowany.";
  } catch {
    link.focus();
    link.select();
    status.textContent = "Skopiuj zaznaczony link.";
  }
});
