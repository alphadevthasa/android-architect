package com.example.legacy;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import butterknife.BindView;
import butterknife.ButterKnife;

public class LoginActivity extends Activity implements LoginContract.View {
    @BindView(R.id.error) TextView error;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);
        ButterKnife.bind(this);
        TextView title = (TextView) findViewById(R.id.title);
    }

    @Override
    public void showError(String message) {
        error.setText(message);
    }
}
