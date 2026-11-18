package com.example.legacy;

import io.reactivex.Single;
import io.reactivex.schedulers.Schedulers;

public class LoginPresenter implements LoginContract.Presenter {
    private final LoginContract.View view;

    public LoginPresenter(LoginContract.View view) {
        this.view = view;
    }

    @Override
    public void login(String user, String password) {
        Single.just(user).subscribeOn(Schedulers.io()).subscribe();
    }
}
