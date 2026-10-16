const input = document.getElementById("endpoint");
const status = document.getElementById("status");

chrome.storage.local.get(["gottaEndpoint"], (res) => {
  if (res.gottaEndpoint) input.value = res.gottaEndpoint;
});

document.getElementById("save").addEventListener("click", () => {
  const val = input.value.trim().replace(/\/+$/, "");
  chrome.storage.local.set({ gottaEndpoint: val }, () => {
    status.textContent = "Credenciales guardadas. Abre ChatGPT o Gemini.";
  });
});
