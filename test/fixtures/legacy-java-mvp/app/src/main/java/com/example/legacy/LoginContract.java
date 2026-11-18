package com.example.legacy;

public interface LoginContract {
    interface View {
        void showError(String message);
    }

    interface Presenter {
        void login(String user, String password);
    }
}
