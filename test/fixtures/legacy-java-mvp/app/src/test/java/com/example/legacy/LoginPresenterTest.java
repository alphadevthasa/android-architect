package com.example.legacy;

import org.junit.Test;
import org.mockito.Mockito;

public class LoginPresenterTest {
    @Test
    public void loginDoesNotCrash() {
        LoginContract.View view = Mockito.mock(LoginContract.View.class);
        new LoginPresenter(view).login("u", "p");
    }
}
