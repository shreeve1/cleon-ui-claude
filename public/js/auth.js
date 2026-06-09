import { state } from "./state.js";
import {
	$,
	authScreen,
	mainScreen,
	authForm,
	authError,
	authBtn,
} from "./dom.js";

function showAuth() {
	authScreen.classList.remove("hidden");
	mainScreen.classList.add("hidden");
}

function showMain() {
	authScreen.classList.add("hidden");
	mainScreen.classList.remove("hidden");
}

async function handleAuthSubmit(e) {
	e.preventDefault();
	const username = $("#username").value.trim();
	const password = $("#password").value;
	const isRegister = authForm.dataset.mode === "register";

	authError.classList.add("hidden");
	authBtn.disabled = true;

	try {
		if (isRegister) {
			await api("/api/auth/register", { username, password });
			authBtn.textContent = "Log In";
			authForm.dataset.mode = "login";
			showAuthError("Account created! Please log in.");
			authBtn.disabled = false;
			return;
		}

		const { token } = await api("/api/auth/login", { username, password });
		state.token = token;
		localStorage.setItem("token", token);
		showMain();
	} catch (err) {
		showAuthError(err.message);
	} finally {
		authBtn.disabled = false;
	}
}

function showAuthError(msg) {
	authError.textContent = msg;
	authError.classList.remove("hidden");
}

export { showAuth, showMain, handleAuthSubmit, showAuthError };
